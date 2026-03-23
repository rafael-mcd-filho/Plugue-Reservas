-- Drop and recreate all FKs referencing companies.id with ON DELETE CASCADE

-- automation_settings
ALTER TABLE public.automation_settings DROP CONSTRAINT IF EXISTS automation_settings_company_id_fkey;
ALTER TABLE public.automation_settings ADD CONSTRAINT automation_settings_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- blocked_dates
ALTER TABLE public.blocked_dates DROP CONSTRAINT IF EXISTS blocked_dates_company_id_fkey;
ALTER TABLE public.blocked_dates ADD CONSTRAINT blocked_dates_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- company_whatsapp_instances
ALTER TABLE public.company_whatsapp_instances DROP CONSTRAINT IF EXISTS company_whatsapp_instances_company_id_fkey;
ALTER TABLE public.company_whatsapp_instances ADD CONSTRAINT company_whatsapp_instances_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- notifications
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_company_id_fkey;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- profiles (set company_id to NULL when company is deleted)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_company_id_fkey;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;

-- reservation_funnel_logs
ALTER TABLE public.reservation_funnel_logs DROP CONSTRAINT IF EXISTS reservation_funnel_logs_company_id_fkey;
ALTER TABLE public.reservation_funnel_logs ADD CONSTRAINT reservation_funnel_logs_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- reservations
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_company_id_fkey;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- restaurant_tables
ALTER TABLE public.restaurant_tables DROP CONSTRAINT IF EXISTS restaurant_tables_company_id_fkey;
ALTER TABLE public.restaurant_tables ADD CONSTRAINT restaurant_tables_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- user_roles
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_company_id_fkey;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- waitlist
ALTER TABLE public.waitlist DROP CONSTRAINT IF EXISTS waitlist_company_id_fkey;
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- webhook_configs
ALTER TABLE public.webhook_configs DROP CONSTRAINT IF EXISTS webhook_configs_company_id_fkey;
ALTER TABLE public.webhook_configs ADD CONSTRAINT webhook_configs_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- whatsapp_message_logs
ALTER TABLE public.whatsapp_message_logs DROP CONSTRAINT IF EXISTS whatsapp_message_logs_company_id_fkey;
ALTER TABLE public.whatsapp_message_logs ADD CONSTRAINT whatsapp_message_logs_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

-- whatsapp_message_queue
ALTER TABLE public.whatsapp_message_queue DROP CONSTRAINT IF EXISTS whatsapp_message_queue_company_id_fkey;
ALTER TABLE public.whatsapp_message_queue ADD CONSTRAINT whatsapp_message_queue_company_id_fkey 
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;