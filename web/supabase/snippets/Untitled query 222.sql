
-- =============================================
-- 1. 检查所有启用了 RLS 但缺少某些操作策略的表
-- =============================================
SELECT 
    t.table_name,
    t.row_security,
    COALESCE(
        string_agg(DISTINCT p.cmd, ', '), 
        '(no policies)'
    ) AS policy_commands,
    CASE 
        WHEN COUNT(DISTINCT p.cmd) FILTER (WHERE p.cmd = 'select') = 0 THEN '⚠️ Missing SELECT'
        WHEN COUNT(DISTINCT p.cmd) FILTER (WHERE p.cmd = 'insert') = 0 THEN '⚠️ Missing INSERT'
        WHEN COUNT(DISTINCT p.cmd) FILTER (WHERE p.cmd = 'update') = 0 THEN '⚠️ Missing UPDATE'
        WHEN COUNT(DISTINCT p.cmd) FILTER (WHERE p.cmd = 'delete') = 0 THEN '⚠️ Missing DELETE'
        ELSE '✅ OK'
    END AS status
FROM information_schema.tables t
LEFT JOIN pg_policies p ON t.table_name = p.tablename AND t.table_schema = p.schemaname
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND t.row_security = true
GROUP BY t.table_name, t.row_security
ORDER BY t.table_name;
-- =============================================
-- 2. 检查所有函数及其 SECURITY DEFINER 属性
-- =============================================
SELECT 
    routine_name,
    data_type AS return_type,
    type_udt_name,
    CASE WHEN is_definer THEN 'DEFINER' ELSE 'INVOKER' END AS security_context
FROM information_schema.routines r
JOIN pg_proc p ON p.proname = r.routine_name
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND r.routine_type = 'FUNCTION'
ORDER BY routine_name;
-- =============================================
-- 3. 检查所有触发器及其配置
-- =============================================
SELECT 
    t.tgname AS trigger_name,
    c.relname AS table_name,
    CASE 
        WHEN t.tgtype & 1 = 1 THEN 'ROW'
        ELSE 'STATEMENT'
    END AS level,
    CASE 
        WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
        WHEN t.tgtype & 4 = 4 THEN 'AFTER'
        WHEN t.tgtype & 8 = 8 THEN 'INSTEAD OF'
    END AS action_timing,
    t.tgop AS operation,
    p.proname AS function_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_proc p ON t.tgfoid = p.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname = 'public';
-- =============================================
-- 4. 检查是否有孤立的外键引用（父表被删除但子表还在）
-- =============================================
SELECT 
    tc.table_name AS child_table,
    kcu.column_name AS foreign_key_column,
    ccu.table_name AS parent_table,
    ccu.column_name AS parent_column,
    rc.delete_rule ON DELETE
FROM information_schema.table_constraints AS tc 
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints AS rc
    ON rc.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' 
  AND tc.table_schema = 'public';
-- =============================================
-- 5. 检查枚举值是否与数据库实际定义一致
-- =============================================
SELECT 
    t.typname AS enum_name,
    unnest(e.enumlabel::text[]) AS enum_value
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typtype = 'e'
ORDER BY t.typname, e.enumsortorder;
-- =============================================
-- 6. 检查 problem_status_history 表是否有正确的唯一索引
-- =============================================
SELECT 
    indexname, 
    indexdef
FROM pg_indexes
WHERE tablename = 'problem_status_history'
  AND schemaname = 'public';

