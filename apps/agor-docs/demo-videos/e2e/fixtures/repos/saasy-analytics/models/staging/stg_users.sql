select
    user_id,
    account_id,
    email,
    role,
    created_at
from {{ source('raw', 'users') }}
