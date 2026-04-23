# Fault Injection Scenarios

Each scenario is a Docker Compose override file. Run it on top of the base
`docker-compose.yml` so only the broken parts are overridden.

All failures are **behavioural** — the root cause lives in real code or config,
and the signals your agent sees are what Docker, Node.js, Nginx, and MongoDB
naturally emit.

---

## How to run any scenario

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-<name>.yml up --build
```

To stop and clean up:

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-<name>.yml down -v
```

---

## Scenarios

### 1. `fault-mongo-down` — MongoDB unreachable

**File:** `docker-compose.fault-mongo-down.yml`

**What breaks:** `MONGO_URI` points to a non-existent hostname (`mongo-broken`).

**Signals your agent should find:**
- `docker logs <backend>` → `MongooseServerSelectionError: getaddrinfo ENOTFOUND mongo-broken`
- Repeated connection retry messages every 30 s
- All `GET /api/items` and `POST /api/items` return HTTP 500
- Frontend renders empty, all writes fail

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-mongo-down.yml up --build
```

---

### 2. `fault-backend-crashloop` — Backend crash-loop on startup

**File:** `docker-compose.fault-backend-crashloop.yml`

**What breaks:** Server throws synchronously during startup because `APP_SECRET`
env var is not set. Node exits with code 1. Docker restarts it. Repeat.

**Signals your agent should find:**
- `docker ps` → `Restarting (1) N seconds ago`
- `docker logs <backend>` → `Error: APP_SECRET is not defined. ...`
- `docker events` → repeated `die` + `start` events for the backend container
- All `/api/*` requests return 502 (nginx upstream down)

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-backend-crashloop.yml up --build
```

---

### 3. `fault-oom` — Memory leak → OOM kill

**File:** `docker-compose.fault-oom.yml`

**What breaks:** Every `POST /api/items` appends a 10 MB buffer to a
module-level array that is never cleared. Container has a 150 MB memory limit.
After ~10–15 POSTs the kernel OOM-kills the process (exit 137).

**Signals your agent should find:**
- `docker stats` → memory climbs steadily to 150 MB then container disappears
- `docker inspect <backend>` → `"OOMKilled": true`
- `docker events` → `die` with `exitCode=137`
- Host `dmesg` / `syslog` → `Out of memory: Kill process ... (node)`
- Container restarts, memory climbs again → repeated OOM cycle
- Frontend: intermittent 502s that clear briefly after each restart

**Trigger the leak:**
```bash
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:5000/api/items \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"item$i\"}" > /dev/null
done
```

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-oom.yml up --build
```

---

### 4. `fault-cpu-spike` — Synchronous CPU spike / event loop block

**File:** `docker-compose.fault-cpu-spike.yml`

**What breaks:** `GET /api/slow` runs 500 000 synchronous SHA-256 hashes on
the main thread. Node's event loop is blocked for the duration — no other
request can be served.

**Signals your agent should find:**
- `docker stats` → CPU% pegged at container quota (0.5 CPU)
- Concurrent `GET /api/items` requests hang / time out while `/api/slow` runs
- No crash, no error log — process is alive but unresponsive
- Client-side: ETIMEDOUT or HTTP 504 on normal API calls
- Node does not log anything — the silence is the signal

**Trigger:**
```bash
# In one terminal — blocks the event loop
curl http://localhost:5000/api/slow

# In another terminal — will hang until the above completes
curl http://localhost:5000/api/items
```

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-cpu-spike.yml up --build
```

---

### 5. `fault-wrong-port` — Port mismatch → 502 Bad Gateway

**File:** `docker-compose.fault-wrong-port.yml`

**What breaks:** Backend binds to port 5001 but nginx still proxies to
`backend:5000`. Both containers are running and show no internal errors.

**Signals your agent should find:**
- `docker logs <frontend>` (nginx) → `connect() failed (111: Connection refused) while connecting to upstream`
- All `/api/*` requests return HTTP 502
- `docker logs <backend>` → `Backend running on http://localhost:5001` (the clue)
- `docker ps` → both containers `Up` — no obvious failure from status alone

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-wrong-port.yml up --build
```

---

### 6. `fault-mongo-auth` — MongoDB auth enabled, backend has no credentials

**File:** `docker-compose.fault-mongo-auth.yml`

**What breaks:** MongoDB is started with `MONGO_INITDB_ROOT_USERNAME/PASSWORD`
(auth enabled). Backend URI has no credentials.

**Signals your agent should find:**
- `docker logs <backend>` → `MongoServerError: Command find requires authentication`
- Backend starts successfully and connects (TCP handshake works) — misleading
- Every query returns HTTP 500 with `{ "error": "Command find requires authentication" }`
- `docker logs <mongo>` → auth-related messages on connection attempts
- `mongosh` with credentials works fine — mongo itself is healthy

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-mongo-auth.yml up --build
```

---

### 7. `fault-db-slowness` — Missing index → query timeouts

**File:** `docker-compose.fault-db-slowness.yml`

**What breaks:** `GET /api/items` sorts on an unindexed field, forcing a full
collection scan + in-memory sort. With a large collection this exceeds
MongoDB's memory limit for sort operations and times out.

**Signals your agent should find:**
- Fast at first (small collection), degrades as data grows
- `docker logs <backend>` → `MongooseError: Operation items.find() buffering timed out`  
  or `MongoServerError: Sort exceeded memory limit`
- `GET /api/items` returns 500; `POST` still works
- MongoDB slow query log shows `COLLSCAN` and high `ms` values

**Seed data to trigger:**
```bash
for i in $(seq 1 300); do
  curl -s -X POST http://localhost:5000/api/items \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"item$i\"}" > /dev/null
done
# Now GET /api/items will be slow / fail
curl http://localhost:5000/api/items
```

```bash
docker compose -f docker-compose.yml -f docker-compose.fault-db-slowness.yml up --build
```

---

## Signal summary for your agent

| Scenario | Container status | Exit code | Key log signal |
|---|---|---|---|
| mongo-down | Running | — | `ENOTFOUND mongo-broken` |
| crashloop | Restarting | 1 | `APP_SECRET is not defined` |
| oom | Restarting | **137** | `OOMKilled: true` in inspect |
| cpu-spike | Running | — | silence + CPU% pegged |
| wrong-port | Running | — | nginx `Connection refused` upstream |
| mongo-auth | Running | — | `requires authentication` |
| db-slowness | Running | — | `buffering timed out` / `COLLSCAN` |
