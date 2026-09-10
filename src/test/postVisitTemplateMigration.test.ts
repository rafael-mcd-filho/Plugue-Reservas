// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('adds nullable template review mode without rewriting existing templates or reservation history', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE public.pluguechat_automation_templates (
        id integer PRIMARY KEY, type text NOT NULL, template_id text NOT NULL, enabled boolean NOT NULL
      );
      ALTER TABLE public.pluguechat_automation_templates ENABLE ROW LEVEL SECURITY;
      INSERT INTO public.pluguechat_automation_templates VALUES
        (1, 'post_visit', 'existing-unknown-template', true),
        (2, 'confirmation_message', 'existing-confirmation', true);
      CREATE TABLE public.reservations (id integer PRIMARY KEY, status text NOT NULL);
      INSERT INTO public.reservations VALUES (1, 'completed');
    `);
    const migration = await readFile(resolve('supabase/migrations/20260910120000_configure_pluguechat_post_visit_review.sql'), 'utf8');
    await database.exec(migration);
    await database.exec(migration);
    expect((await database.query('SELECT * FROM public.pluguechat_automation_templates ORDER BY id')).rows).toEqual([
      { id: 1, type: 'post_visit', template_id: 'existing-unknown-template', enabled: true, post_visit_include_review_link: null },
      { id: 2, type: 'confirmation_message', template_id: 'existing-confirmation', enabled: true, post_visit_include_review_link: null },
    ]);
    expect((await database.query('SELECT * FROM public.reservations')).rows).toEqual([{ id: 1, status: 'completed' }]);
    expect((await database.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pluguechat_automation_templates'::regclass")).rows)
      .toEqual([{ relrowsecurity: true }]);
    await database.exec('UPDATE public.pluguechat_automation_templates SET post_visit_include_review_link = false WHERE id = 1');
    expect((await database.query('SELECT post_visit_include_review_link FROM public.pluguechat_automation_templates WHERE id = 1')).rows)
      .toEqual([{ post_visit_include_review_link: false }]);
    await database.exec('UPDATE public.pluguechat_automation_templates SET post_visit_include_review_link = true WHERE id = 1');
    expect((await database.query('SELECT post_visit_include_review_link FROM public.pluguechat_automation_templates WHERE id = 1')).rows)
      .toEqual([{ post_visit_include_review_link: true }]);
  } finally {
    await database.close();
  }
}, 15000);
