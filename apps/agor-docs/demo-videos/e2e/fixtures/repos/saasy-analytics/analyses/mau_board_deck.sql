-- MAU for the monthly board deck (finance). Written by Kai, March.
-- "Active" = logged in at least once that month.
select
    date_trunc('month', occurred_at) as month,
    count(distinct user_id) as mau
from raw.events
where event_name = 'login'
group by 1
order by 1 desc
