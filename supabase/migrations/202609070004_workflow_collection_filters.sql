-- Preserve the collection's product filters after adding compiler workflow states.
create or replace function public.scout_watches_page(
  page_offset integer default 0,
  search_text text default '',
  status_filter text default 'all',
  sort_order text default 'newest'
) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value),'[]'::jsonb) from (
  select app_private.watch_json(w) || jsonb_build_object(
    'recentIncidents',
    coalesce((
      select jsonb_agg(app_private.incident_json(i) || '{"context":null,"explanation":null}'::jsonb order by i.created_at desc,i.id)
      from (
        select * from public.incidents
        where watch_id=w.id and user_id=auth.uid()
        order by created_at desc,id
        limit 6
      ) i
    ),'[]'::jsonb)
  ) value
  from public.watches w
  where w.user_id=auth.uid()
    and (
      search_text='' or
      w.name ilike '%'||replace(replace(left(search_text,100),'%','\%'),'_','\_')||'%' escape '\'
    )
    and case status_filter
      when 'archived' then w.status='archived'
      when 'all' then w.status<>'archived'
      when 'watching' then w.status in ('watching','live','delayed')
      when 'attention' then w.status in ('needs_clarification','failed','degraded','delayed') or w.error is not null
      else w.status=status_filter
    end
  order by
    case when sort_order='name' then lower(w.name) end,
    case when sort_order='oldest' then w.created_at end,
    case when sort_order not in ('name','oldest') then w.created_at end desc,
    w.id
  offset greatest(0,least(page_offset,100000))
  limit 21
 ) q;
$$;
