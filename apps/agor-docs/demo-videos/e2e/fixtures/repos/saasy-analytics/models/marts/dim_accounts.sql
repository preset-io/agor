select
    a.account_id,
    a.account_name,
    a.plan,
    a.industry,
    a.region,
    a.is_internal,
    a.created_at,
    a.churned_at,
    count(u.user_id) as seats
from {{ ref('stg_accounts') }} a
left join {{ ref('stg_users') }} u using (account_id)
group by all
