select
    event_id,
    user_id,
    account_id,
    event_name,
    platform,
    occurred_at
from {{ source('raw', 'events') }}
