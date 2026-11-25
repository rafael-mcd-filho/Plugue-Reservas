import assert from 'node:assert/strict';

export async function runAutoTableCombinationScenarios({ db, company, otherCompany, admin, outsider, salon, premium, actor, loadFunction, migration }) {
  const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
  await db.exec('RESET ROLE');
  await loadFunction('20260923120000_optimize_public_reservation_flow', 'get_public_reservation_booking_context');
  for (const name of [
    '20261124130000_reservation_table_combinations',
    '20261124131000_auto_assign_reservation_table_combinations',
    '20261124132000_auto_table_combination_changes',
  ]) await db.exec(await migration(name));

  // Migration replay must not duplicate triggers, grants or patches.
  for (const name of [
    '20261124130000_reservation_table_combinations',
    '20261124131000_auto_assign_reservation_table_combinations',
    '20261124132000_auto_table_combination_changes',
  ]) await db.exec(await migration(name));

  await db.exec(`UPDATE test_schedule SET availability_mode='tables';
    UPDATE reservation_schedule_rules SET availability_mode='tables' WHERE id='99999999-9999-4999-8999-999999999999';
    UPDATE reservation_schedule_rule_blocks SET availability_mode='tables' WHERE id='99999999-9999-4999-8999-999999999998';
    UPDATE reservation_schedule_rule_slots SET allow_section_selection=true,max_guests_per_slot=10000,max_reservations_per_slot=NULL
      WHERE rule_id='99999999-9999-4999-8999-999999999999';
    UPDATE reservation_schedule_rule_slot_sections SET capacity_guests=NULL WHERE slot_id IN (
      SELECT id FROM reservation_schedule_rule_slots WHERE rule_id='99999999-9999-4999-8999-999999999999');
    UPDATE companies SET feature_enabled=false,max_guests_per_slot=10000;`);
  const map = '20000000-0000-4000-8000-000000000050';
  await db.query(`INSERT INTO table_maps(id,company_id,name,is_default,is_enabled,active_from,active_to)
    VALUES($1,$2,'Combinações',false,true,'2030-05-01 00:00+00','2030-06-01 00:00+00')`, [map, company]);
  const tables = (await db.query(`INSERT INTO restaurant_tables(id,company_id,table_map_id,number,capacity,section)
    SELECT gen_random_uuid(),$1,$2,number,capacity,section FROM (VALUES
      (101,2,'salao'),(102,4,'salao'),(103,4,'salao'),(104,4,'salao'),(105,4,'sacada'),(106,4,'sacada')
    ) f(number,capacity,section) RETURNING id,number`, [company, map])).rows;
  const table = n => tables.find(t => t.number === n).id;
  await db.exec('GRANT SELECT ON restaurant_tables,reservation_table_assignments TO authenticated,service_role');
  const book = (extra = {}, status = 'confirmed') => scalar(
    'SELECT to_jsonb(create_public_reservation($1::jsonb,$2)) value', [JSON.stringify({
      company_id: company, date: '2030-05-01', time: '18:00', party_size: 8,
      guest_name: 'Grupo', guest_phone: '+5511999999999', guest_birthdate: '1990-01-01', selected_section_id: salon,
      ...extra,
    }), status]);
  const assigned = async id => (await db.query(`SELECT t.number,t.capacity,t.section FROM reservation_table_assignments a
    JOIN restaurant_tables t ON t.id=a.table_id WHERE a.reservation_id=$1 ORDER BY a.sort_order`, [id])).rows;
  const available = async (day, size) => (await db.query(
    'SELECT * FROM get_public_reservation_availability($1,$2,$3)', [company, day, size])).rows;
  const options = (day, size) => scalar('SELECT get_public_reservation_section_options($1,$2,$3,$4) value', [company, day, '18:00', size]);

  await actor('anon');
  assert.equal((await available('2030-05-01', 8)).find(s => s.time_slot === '18:00:00').available, true,
    'availability accepts a group that needs multiple tables');
  const sectionOptions = await options('2030-05-01', 8);
  assert.equal(sectionOptions.options.find(s => s.section_id === salon).available, true);
  assert.equal(sectionOptions.options.find(s => s.section_id === premium).available, true);
  assert.equal((await options('2030-05-01', 9)).options.find(s => s.section_id === premium).available, false,
    'two tables of four do not accept nine people');
  const context = (await db.query('SELECT * FROM get_public_reservation_booking_context($1,$2,$3)', [company, '2030-05-01', 8])).rows;
  assert.ok(context.find(s => s.time_slot === '18:00:00').recommended_table_id,
    'public booking context recommends a combination through its compatible primary ID');
  await assert.rejects(db.query('SELECT pick_best_fit_reservation_tables($1,$2,$3,$4,$5,$6)',
    [company, '2030-05-01', '18:00', 60, 8, map]), /permission denied/,
    'anonymous users cannot call internal planner directly');

  await actor('service_role');
  const group = await book();
  assert.deepEqual((await assigned(group.id)).map(t => t.number), [102, 103]);
  assert.equal(await scalar('SELECT party_size value FROM reservations WHERE id=$1', [group.id]), 8);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservations WHERE id=$1', [group.id]), 1,
    'eight people occupy two tables but remain one reservation');
  assert.equal((await options('2030-05-01', 8)).options.find(s => s.section_id === salon).available, false,
    'occupied secondary tables are excluded from subsequent combinations');
  await assert.rejects(book(), /indisponivel|disponivel|atingid/i);
  assert.equal((await options('2030-05-01', 8)).options.find(s => s.section_id === premium).available, true,
    'one environment being full does not consume a different environment');
  const premiumBooking = await book({ selected_section_id: premium });
  assert.deepEqual((await assigned(premiumBooking.id)).map(t => t.number), [105, 106]);
  await assert.rejects(book({ date: '2030-05-02', selected_section_id: premium, party_size: 9 }), /indisponivel|disponivel/i);
  const exact = await book({ date: '2030-05-02', party_size: 2 });
  assert.deepEqual((await assigned(exact.id)).map(t => t.number), [101], 'two guests use the two-seat table');

  // No section-selection rule still uses one environment per group.
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET allow_section_selection=false WHERE time='18:00'");
  await actor('service_role');
  const legacy = await book({ date: '2030-05-03', selected_section_id: null, table_id: table(102) });
  assert.deepEqual((await assigned(legacy.id)).map(t => t.number), [102, 103]);
  const automaticWithoutSelection = await book({ date: '2030-05-10', selected_section_id: null });
  assert.deepEqual((await assigned(automaticWithoutSelection.id)).map(t => t.number), [102,103],
    'public creation without an explicit primary also combines tables');
  const large = await book({ date: '2030-05-04', party_size: 9, selected_section_id: null });
  assert.equal((await assigned(large.id)).reduce((n,t) => n+t.capacity,0), 10,
    'best-fit chooses the smallest sufficient total rather than squeezing nine into eight seats');
  assert.equal(new Set((await assigned(large.id)).map(t => t.section)).size, 1);

  await actor('authenticated', admin);
  const manual = await scalar(`SELECT to_jsonb(create_panel_reservation($1,$2,'18:00',8,'Grupo manual','+5511999999999')) value`,
    [company, '2030-05-05']);
  assert.equal((await assigned(manual.id)).length, 2, 'panel automatic creation uses the same combination planner');
  const anchored = await scalar(`SELECT to_jsonb(create_panel_reservation($1,$2,'18:00',8,'Grupo manual','+5511999999999',NULL,NULL,NULL,NULL,$3)) value`,
    [company, '2030-05-06', table(103)]);
  assert.equal(anchored.table_id, table(103));
  assert.equal((await assigned(anchored.id)).length, 2);
  const edited = await scalar(`SELECT to_jsonb(update_panel_reservation($1,$2,'18:30',8,'Nome alterado','+5511999999999',NULL,NULL,NULL,NULL,true,false,NULL)) value`,
    [manual.id, '2030-05-05']);
  assert.equal(edited.party_size, 8);
  assert.equal((await assigned(edited.id)).length, 2, 'editing time preserves a full combination');
  const reduced = await scalar(`SELECT to_jsonb(update_panel_reservation($1,$2,'18:30',2,'Nome alterado','+5511999999999',NULL,NULL,NULL,NULL,false,false,NULL)) value`,
    [manual.id, '2030-05-05']);
  assert.equal((await assigned(reduced.id)).length, 1, 'reducing the group releases surplus tables');
  assert.deepEqual((await assigned(reduced.id)).map(t => t.number), [101]);
  await actor('authenticated', outsider);
  await assert.rejects(db.query(`SELECT create_panel_reservation($1,$2,'18:00',8,'Outro','+5511999999999')`, [company, '2030-05-05']), /permissao|permission|autorizado/i);

  // Cancellation makes every assigned table reusable, without deleting history.
  await db.exec('RESET ROLE');
  await db.query("UPDATE reservations SET status='cancelled' WHERE id=$1", [group.id]);
  await actor('service_role');
  const reused = await book({ selected_section_id: null, table_id: table(102) });
  assert.deepEqual((await assigned(reused.id)).map(t => t.number), [102,103]);
  assert.equal((await assigned(group.id)).length, 2);

  // A pending payment holds every secondary table, and confirming the payment
  // preserves the complete allocation instead of collapsing to its primary.
  const held = await book({ date: '2030-05-11', selected_section_id: null }, 'pending_payment');
  assert.equal((await assigned(held.id)).length, 2);
  const payment = await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,charged_amount,billing_type,status,expires_at)
    VALUES($1,$2,80,80,'PIX','awaiting_method',now()+interval '10 minutes') RETURNING id value`, [company, held.id]);
  assert.equal((await available('2030-05-11', 8)).find(s => s.time_slot==='18:00:00').available, true,
    'a different environment remains free while the normal combination is held');
  const paid = await scalar("SELECT confirm_reservation_payment($1,$2,'RECEIVED',now(),'{}','offline-test') value", [payment,company]);
  assert.equal(paid.status, 'paid');
  assert.equal((await assigned(held.id)).length, 2);

  const expiring = await book({ date: '2030-05-12', selected_section_id: null, table_id: table(102) }, 'pending_payment');
  const expiredPayment = await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,charged_amount,billing_type,status,expires_at)
    VALUES($1,$2,80,80,'PIX','expired',now()-interval '1 minute') RETURNING id value`, [company, expiring.id]);
  await db.query("UPDATE reservations SET created_at=now()-interval '1 hour' WHERE id=$1", [expiring.id]);
  const replacement = await book({ date: '2030-05-12', selected_section_id: null, table_id: table(102) });
  assert.equal((await assigned(replacement.id)).length, 2);
  const latePaid = await scalar("SELECT confirm_reservation_payment($1,$2,'RECEIVED',now(),'{}','offline-test') value", [expiredPayment,company]);
  assert.equal(latePaid.status, 'late_paid', 'an expired combination cannot reclaim a secondary table sold to another group');
  assert.equal((await assigned(replacement.id)).length, 2);

  // Guest and reservation quotas remain independent from physical table counts.
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET max_reservations_per_slot=1 WHERE time='18:00'");
  await actor('service_role');
  await book({ date: '2030-05-07', selected_section_id: null });
  await assert.rejects(book({ date: '2030-05-07', selected_section_id: null, party_size: 2 }), /Limite de reservas/);
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET max_reservations_per_slot=NULL,max_guests_per_slot=7 WHERE time='18:00'");
  await actor('service_role');
  await assert.rejects(book({ date: '2030-05-08', selected_section_id: null }), /Limite de pessoas/);
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET max_guests_per_slot=10000,allow_section_selection=true");
  await db.query('UPDATE reservation_schedule_rule_slot_sections SET capacity_guests=7 WHERE section_id=$1', [salon]);
  await actor('service_role');
  await assert.rejects(book({ date: '2030-05-09' }), /Capacidade do ambiente/);

  await db.exec('RESET ROLE');
  console.log('Automatic table combination regressions passed: public/panel, environment isolation, eight versus nine guests, updates, cancellation, quotas, ACL and migration replay.');
}
