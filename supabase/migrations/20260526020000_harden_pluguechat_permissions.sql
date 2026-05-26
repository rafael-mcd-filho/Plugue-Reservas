-- Restrict PlugueChat template writes to admins/superadmins.
-- Operators may keep read access through the existing SELECT policy.

DROP POLICY IF EXISTS "pluguechat_templates_insert"
  ON public.pluguechat_automation_templates;

DROP POLICY IF EXISTS "pluguechat_templates_update"
  ON public.pluguechat_automation_templates;

CREATE POLICY "pluguechat_templates_insert"
  ON public.pluguechat_automation_templates
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
        AND ur.role = 'admin'
    )
  );

CREATE POLICY "pluguechat_templates_update"
  ON public.pluguechat_automation_templates
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
        AND ur.role = 'admin'
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
        AND ur.role = 'admin'
    )
  );
