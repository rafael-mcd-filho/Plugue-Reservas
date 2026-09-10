-- Explicit contract for the post-visit template only.
-- NULL keeps existing templates in legacy mode; never infer variables from an ID.
-- false sends nome/data; true also requires the review token (not its full URL).
-- Bound the DDL wait during rollout; these settings affect this migration session only.
SET lock_timeout = '3s';
SET statement_timeout = '30s';

ALTER TABLE public.pluguechat_automation_templates
  ADD COLUMN IF NOT EXISTS post_visit_include_review_link boolean;

COMMENT ON COLUMN public.pluguechat_automation_templates.post_visit_include_review_link IS
  'Post-visit only: NULL preserves legacy parameters; false sends nome/data; true requires link_avaliacao as the token after /avaliacao/.';

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
RESET statement_timeout;
