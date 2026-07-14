-- =============================================
-- Add missing RLS policies for content_limit_overrides and problem_set_views
-- These tables have RLS enabled but no policies defined
-- =============================================

-- =============================================
-- content_limit_overrides table policies
-- =============================================

CREATE POLICY content_limit_overrides_select ON public.content_limit_overrides
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY content_limit_overrides_insert ON public.content_limit_overrides
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY content_limit_overrides_update ON public.content_limit_overrides
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY content_limit_overrides_delete ON public.content_limit_overrides
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================
-- problem_set_views table policies
-- =============================================

CREATE POLICY problem_set_views_select ON public.problem_set_views
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY problem_set_views_insert ON public.problem_set_views
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY problem_set_views_update ON public.problem_set_views
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY problem_set_views_delete ON public.problem_set_views
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
