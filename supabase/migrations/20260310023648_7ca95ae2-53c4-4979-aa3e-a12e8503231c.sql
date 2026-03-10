
-- Allow company staff to delete/update queue entries
CREATE POLICY "Company staff can manage message queue"
  ON public.whatsapp_message_queue FOR ALL
  TO authenticated
  USING (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR
    has_role_in_company(auth.uid(), 'operator'::app_role, company_id) OR
    has_role(auth.uid(), 'superadmin'::app_role)
  )
  WITH CHECK (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR
    has_role_in_company(auth.uid(), 'operator'::app_role, company_id) OR
    has_role(auth.uid(), 'superadmin'::app_role)
  );

-- Drop the old SELECT-only policy since the ALL policy covers it
DROP POLICY IF EXISTS "Company staff can view message queue" ON public.whatsapp_message_queue;
