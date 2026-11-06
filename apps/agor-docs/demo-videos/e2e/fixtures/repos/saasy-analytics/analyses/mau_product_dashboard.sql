-- MAU tile on the product dashboard. Written by Grace, June.
-- Counts anyone with any event in the month.
select
    date_trunc('month', occurred_at) as month,
    count(distinct user_id) as mau
from raw.events
group by 1
order by 1 desc
