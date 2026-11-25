import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runAutoTableCombinationChangeScenarios({ db, company, actorId, map, tableA, tableB, tableC,
  owner, anon, add, rule, test, change, options, one, load }) {
  await owner();
  const normal = randomUUID(), premium = randomUUID(), normalFour = randomUUID(), normalThird = randomUUID();
  const normalTwo = randomUUID(), premiumA = randomUUID(), premiumB = randomUUID();
  await db.exec(`
    ALTER TABLE public.reservations ADD COLUMN selected_section_id uuid, ADD COLUMN selected_section_name text;
    ALTER TABLE public.reservation_schedule_rule_slots ADD COLUMN allow_section_selection boolean NOT NULL DEFAULT false;
    CREATE TABLE public.table_sections(id uuid PRIMARY KEY,company_id uuid,code text,name text);
    CREATE TABLE public.reservation_schedule_rule_slot_sections(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,slot_id uuid,section_id uuid,
      capacity_guests integer,enabled boolean DEFAULT true,sort_order integer DEFAULT 0);
    CREATE FUNCTION public.effective_auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;
  `);
  await db.query('INSERT INTO table_sections VALUES($1,$3,\'Salão\',\'Normal\'),($2,$3,\'premium\',\'Premium\')', [normal,premium,company]);
  await db.query(`INSERT INTO restaurant_tables(id,company_id,table_map_id,number,capacity,section,status) VALUES
    ($1,$6,$7,4,4,'Salão','available'),($2,$6,$7,5,4,'Salão','available'),
    ($3,$6,$7,6,2,'Salão','available'),($4,$6,$7,7,4,'premium','available'),($5,$6,$7,8,4,'premium','available')`,
  [normalFour,normalThird,normalTwo,premiumA,premiumB,company,map]);
  await db.query("UPDATE restaurant_tables SET status='maintenance' WHERE id=ANY($1::uuid[])", [[tableB,tableC]]);

  const loadFunction = async (file,name) => {
    const source=await load(file);
    let start=source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if(start<0) start=source.indexOf(`CREATE FUNCTION public.${name}(`);
    assert.ok(start>=0,`function ${name} exists`);
    const finish=source.indexOf('$$;',start); assert.ok(finish>start);
    await db.exec(source.slice(start,finish+3));
  };
  // Real pricing helpers provide the optional per-environment quota contract;
  // identity and minimal table schemas remain the established offline fixture.
  for(const name of ['resolve_public_reservation_section_slot','count_overlapping_reservation_section_guests',
    'reservation_section_capacity_available']) await loadFunction('20261124120000_add_reservation_section_pricing',name);
  await db.exec(await load('20261124130000_reservation_table_combinations'));
  for(const name of ['pick_reservation_slot_table_combination','lock_reservation_table_combination',
    'persist_reservation_table_combination']) await loadFunction('20261124131000_auto_assign_reservation_table_combinations',name);
  const changesMigration=await load('20261124132000_auto_table_combination_changes');
  await db.exec(changesMigration); await db.exec(changesMigration);

  const assignments = async id => (await db.query(`SELECT a.table_id,t.capacity,t.section FROM reservation_table_assignments a
    JOIN restaurant_tables t ON t.id=a.table_id WHERE a.reservation_id=$1 ORDER BY a.sort_order`,[id])).rows;
  const combinedBooking = async (extra={}) => {
    const r=await add({party_size:8,table_id:tableA,selected_section_id:normal,selected_section_name:'Normal',...extra});
    await owner();
    await db.query('SELECT persist_reservation_table_combination($1,$2)',[r.id,[tableA,normalFour]]);
    await anon(); return r;
  };

  await test('automatic combination customer change persists every table and replays without extra work',async()=>{
    const r=await combinedBooking(),request=randomUUID();
    assert.equal((await options(r)).slots.find(s=>s.time==='20:00').available,true);
    const changed=await change(r,{},request);
    assert.equal(changed.changed,true);
    await owner();
    const rows=await assignments(r.id);
    assert.equal(rows.length,2); assert.equal(rows.reduce((sum,t)=>sum+t.capacity,0),8);
    assert.ok(rows.every(t=>t.section==='Salão'));
    assert.equal((await one('SELECT table_id FROM reservations WHERE id=$1',[r.id])).table_id,rows[0].table_id);
    await anon();
    const replay=await change(r,{},request); assert.equal(replay.changed,true); assert.equal(replay.replayed,true);
    await owner(); assert.deepEqual(await assignments(r.id),rows);
    assert.equal(Number((await one("SELECT count(*) FROM reservation_audit_logs WHERE reservation_id=$1 AND action='updated'",[r.id])).count),1);
    assert.equal(Number((await one('SELECT count(*) FROM notifications')).count),1);
    assert.equal((await one("SELECT current_setting('app.multi_table_sync',true) AS context")).context,'');
  });

  await test('reducing an automatically combined customer booking releases surplus tables',async()=>{
    const r=await combinedBooking();
    assert.equal((await change(r,{party_size:2})).changed,true);
    await owner();
    const rows=await assignments(r.id);
    assert.deepEqual(rows.map(t=>t.table_id),[normalTwo]);
    assert.equal((await one('SELECT reservation_table_conflict_id($1,$2,\'20:00\',60,$3,NULL) AS conflict',[company,r.date,tableA])).conflict,null);
  });

  await test('customer change refuses nine guests in two four-seat tables without crossing environments',async()=>{
    const r=await combinedBooking();
    await owner();
    await db.query("UPDATE restaurant_tables SET status='maintenance' WHERE id=ANY($1::uuid[])",[[normalTwo,normalThird]]);
    await anon();
    assert.equal((await options(r,null,9)).slots.find(s=>s.time==='20:00').available,false);
    assert.equal((await change(r,{party_size:9})).reason,'full');
    await owner(); assert.deepEqual((await assignments(r.id)).map(t=>t.table_id),[tableA,normalFour]);
    await db.query("UPDATE restaurant_tables SET status='available' WHERE id=ANY($1::uuid[])",[[normalTwo,normalThird]]);
  });

  await test('changing a combined booking to capacity mode clears physical assignments atomically',async()=>{
    const r=await combinedBooking({selected_section_id:null,selected_section_name:null});
    await rule(r.date,{mode:'capacity',maxGuests:20});
    const result=await change(r); assert.equal(result.changed,true);
    await owner();
    assert.deepEqual(await assignments(r.id),[]);
    const stored=await one('SELECT table_id,created_in_mode FROM reservations WHERE id=$1',[r.id]);
    assert.equal(stored.table_id,null); assert.equal(stored.created_in_mode,'capacity');
  });

  await test('financial history continues to protect a combined booking against customer changes',async()=>{
    const r=await combinedBooking(); await owner();
    await db.query("INSERT INTO reservation_payments(company_id,reservation_id,status) VALUES($1,$2,'paid')",[company,r.id]);
    await anon();
    assert.equal((await change(r)).reason,'payment');
    await owner(); assert.deepEqual((await assignments(r.id)).map(t=>t.table_id),[tableA,normalFour]);
  });

  await test('cancelling an automatically combined booking releases every table while keeping assignment history',async()=>{
    const r=await combinedBooking(); await owner();
    await db.query("UPDATE reservations SET status='cancelled' WHERE id=$1",[r.id]);
    assert.equal((await assignments(r.id)).length,2);
    for(const id of [tableA,normalFour]) assert.equal((await one(
      'SELECT reservation_table_conflict_id($1,$2,\'19:00\',60,$3,NULL) AS conflict',[company,r.date,id])).conflict,null);
  });

  await test('table-mode edits hold the capacity-day lock before checking global guest quotas without section selection',async()=>{
    const r=await combinedBooking({selected_section_id:null,selected_section_name:null});
    await rule(r.date,{mode:'tables',maxGuests:8});
    await owner();
    await db.query('UPDATE companies SET public_reservation_changes_enabled=false WHERE id=$1',[company]);
    const original=(await one("SELECT pg_get_functiondef('public.count_overlapping_reservation_guests(uuid,date,time,integer,uuid)'::regprocedure) AS definition")).definition;
    await db.exec(original.replace('public.count_overlapping_reservation_guests(', 'public._test_original_count_overlapping_reservation_guests('));
    await db.exec(`CREATE OR REPLACE FUNCTION public.count_overlapping_reservation_guests(
      _company_id uuid,_date date,_time time,_duration_minutes integer,_exclude_reservation_id uuid DEFAULT NULL
    ) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
        AND classid::bigint=((hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0)>>32)&4294967295)
        AND objid::bigint=(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0)&4294967295)) THEN
        RAISE EXCEPTION 'Guest quota was read before the capacity-day lock.';
      END IF;
      RETURN public._test_original_count_overlapping_reservation_guests(
        _company_id,_date,_time,_duration_minutes,_exclude_reservation_id);
    END; $$;`);
    try {
      await db.exec('BEGIN');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[actorId]);
      await db.exec('SET ROLE authenticated');
      const edited=await one(`SELECT to_jsonb(update_panel_reservation($1,$2,'20:00',8,
        'Grupo editado','+5500000000000',NULL,NULL,NULL,NULL,true,false,NULL)) AS reservation`,[r.id,r.date]);
      await owner();
      assert.equal(edited.reservation.party_size,8);
      assert.equal((await assignments(r.id)).length,2);
      await db.exec('COMMIT');
    } finally {
      await owner();
      await db.exec('ROLLBACK');
      await db.exec(original);
      await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','',false)");
    }
  });
}
