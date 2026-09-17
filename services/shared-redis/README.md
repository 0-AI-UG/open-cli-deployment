# Shared Redis

This standalone OCD service supplies private Redis to multiple application environments, like `ocd-shared-postgres` supplies PostgreSQL. The service belongs to the `shared-data` environment and is outside application stacks, so reconciling a project stack cannot delete it.

Deploy the existing service with `ocd deploy services/shared-redis/release.json --app=sight-redis`. The app name and `sight-redis.ocd.internal` hostname are retained to avoid a client cutover; the service is shared despite the historical name. Its provider volume `106478079` is retained at `/data`. Do not create another Redis app or change the volume ID when updating the image.

The password and global memory settings (`SHARED_REDIS_PASSWORD`, `REDIS_MAXMEMORY_BYTES`, and `REDIS_MAXMEMORY_POLICY`) are stored in `shared-data`. Each consuming project stores its own secret `REDIS_URL` in its application environment, pointing at `sight-redis.ocd.internal:6379`. Use project-specific key prefixes to avoid collisions. Redis is used for caches and short-lived coordination; durable application state belongs in PostgreSQL.
