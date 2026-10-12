select
    account_id,
    name as account_name,
    plan,
    industry,
    region,
    is_internal,
    created_at,
    churned_at
from {{ source('raw', 'accounts') }}
