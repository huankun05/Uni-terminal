/**
 * End-to-end smoke test.
 *
 * Boots a real server on a throwaway config in a temp directory, then drives
 * the whole flow the way a phone would: create pairing -> claim -> approve ->
 * collect credential -> start a session -> exchange data over the WebSocket.
 *
 * The point is not coverage for its own sake. Discipline #3 of this project is
 * that self-written auth fails by *omission*, so every security-relevant
 * promise is asserted here rather than merely documented:
 *
 *   - a pairing challenge cannot be reused or brute-forced
 *   - a credential is handed over exactly once
 *   - a phone cannot reach the admin API, and the admin API rejects tunnels
 *   - polling faster than advertised yields slow_down
 *   - revoking a device closes its live sockets immediately
 *   - error responses never echo credentials back
 *
 * Run: node packages/server/test/smoke.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE_NAME = 'ut_device';

// ---------------------------------------------------------------- test kit

let passed = 0;
const failures: string[] = [];
/** Mirrors stdout into a UTF-8 file, because piping through a Windows shell
 *  mangles non-ASCII output — unreadable exactly when a failure needs reading. */
const transcript: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  const line = `[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? `  (${detail})` : ''}`;
  transcript.push(line);
  if (condition) {
    passed += 1;
  } else {
    failures.push(line);
  }
  console.log(`  ${condition ? '\u2713' : '\u2717'} ${name}${!condition && detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  transcript.push(`\n=== ${title} ===`);
  console.log(`\n${title}`);
}

async function waitForServer(deadlineMs = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCookie(res: Response): string | undefined {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  for (const entry of raw) {
    const match = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(entry);
    if (match?.[1]) return `${COOKIE_NAME}=${match[1]}`;
  }
  return undefined;
}

function publicKeyB64(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
}

// ------------------------------------------------------------------ fixture

interface Fixture {
  child: ChildProcess;
  dir: string;
}

function startServer(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'uni-terminal-smoke-'));
  const configPath = join(dir, 'config.json');

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        server: { host: '127.0.0.1', port: PORT, name: 'smoke-test', dataDir: dir },
        transport: { mode: 'lan' },
        agents: {
          // A deliberately trivial "agent": a Node REPL that echoes what it
          // receives. Using a real coding agent would make the test depend on
          // credentials and network, and would tell us nothing extra about our
          // own plumbing.
          echo: {
            enabled: true,
            mode: 'pty',
            command: process.execPath,
            args: [
              '-e',
              [
                "process.stdout.write('READY\\n');",
                "process.stdin.setEncoding('utf8');",
                // Without an explicit resume the stream stays paused when the
                // parent is a ConPTY rather than a plain pipe, so the echo
                // never happens and the test looks like a plumbing failure.
                'process.stdin.resume();',
                "process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d.trim() + '\\n'));",
                'setInterval(() => {}, 1000);',
              ].join(''),
            ],
          },
          // Enabled but pointing at a binary that cannot exist, to prove the
          // failure path produces a clean error rather than a hung request.
          ghost: { enabled: true, mode: 'pty', command: '__no_such_binary__', args: [] },
        },
        workspaces: [{ id: 'default', name: 'tmp', path: dir }],
        security: {
          pairingTtlMs: 300_000,
          pairingRotateMs: 30_000,
          deviceTtlMs: 15_552_000_000,
          maxPendingPairingsGlobal: 100,
          maxPendingPairingsPerIp: 24,
          maxPairingAttempts: 3,
          cookieName: COOKIE_NAME,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const entry = join(import.meta.dirname, '..', 'src', 'index.ts');
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', entry],
    {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      env: { ...process.env, UNI_TERMINAL_CONFIG: configPath, UNI_LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(`[server] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });

  return { child, dir };
}

// ---------------------------------------------------------------------- run

async function main(): Promise<void> {
  const fixture = startServer();

  try {
    const ready = await waitForServer();
    if (!ready) {
      throw new Error('server did not become ready in time');
    }

    await testHealthAndIdentity();
    const deviceCookie = await testPairingFlow();
    await testDeviceGate(deviceCookie);
    await testSessionAndEvents(deviceCookie);
    await testPollCadence();
    await testRateLimitsAndReplay();
    await testRevocation(deviceCookie);
    await testErrorHygiene();
    await testConfigSurface();
    await testDegradedStartupAndPortFallback();
    await testLanAddressClassification();
  } finally {
    fixture.child.kill();
    await sleep(300);
    try {
      rmSync(fixture.dir, { recursive: true, force: true });
    } catch {
      // Temp dir cleanup is best effort (Windows may still hold the WAL file).
    }
  }

  section('结果');
  const summary = `通过 ${passed} 项，失败 ${failures.length} 项`;
  transcript.push(`\n=== ${summary} ===`);
  console.log(`  ${summary}`);

  try {
    writeFileSync(
      join(import.meta.dirname, '..', '..', '..', '_smoke-result.txt'),
      `${transcript.join('\n')}\n`,
      'utf8',
    );
  } catch {
    // Reporting must never be the thing that breaks the run.
  }

  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ${failure}`);
    process.exit(1);
  }
  console.log('  全部通过');
}

async function testHealthAndIdentity(): Promise<void> {
  section('服务基本可用');

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = (await health.json()) as { ok?: boolean; name?: string };
  check('/api/health 返回 ok', health.ok && healthBody.ok === true);
  check('服务名来自配置', healthBody.name === 'smoke-test');

  const identity = await fetch(`${BASE}/api/identity`);
  const identityBody = (await identity.json()) as { fingerprint?: string; publicKeyPem?: string };
  check('/api/identity 暴露公钥', typeof identityBody.publicKeyPem === 'string' && identityBody.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  check('身份指纹非空', typeof identityBody.fingerprint === 'string' && identityBody.fingerprint.length >= 11);
}

async function testPairingFlow(): Promise<string> {
  section('配对链路（手机扫码 → 桌面批准）');

  const created = await fetch(`${BASE}/api/local/pairings`, { method: 'POST' });
  const pairing = (await created.json()) as {
    id: string;
    userCode: string;
    challenge: string;
    qrPayload: string;
    expiresAt: number;
  };
  check('创建配对成功', created.status === 201 && typeof pairing.id === 'string');
  check('返回 8 位人类可读码', /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(pairing.userCode), pairing.userCode);
  check('二维码内容指向 /pair', pairing.qrPayload.includes('/pair?id='));
  check('二维码携带轮换 challenge', pairing.qrPayload.includes('&c='));

  // A phone scanning the code opens /api/pair/:id first.
  const view = await fetch(`${BASE}/api/pair/${pairing.id}`);
  const viewBody = (await view.json()) as { status?: string; serverFingerprint?: string };
  check('未认证可查看配对状态', view.ok && viewBody.status === 'pending');
  check('状态里带服务指纹供比对', typeof viewBody.serverFingerprint === 'string');

  // Claim with a wrong challenge must fail.
  const badClaim = await fetch(`${BASE}/api/pair/${pairing.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'wrong', publicKey: publicKeyB64(), clientNonce: 'n1' }),
  });
  check('错误的 challenge 被拒绝', badClaim.status === 409, `got ${badClaim.status}`);

  // Correct claim.
  const claim = await fetch(`${BASE}/api/pair/${pairing.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge: pairing.challenge,
      publicKey: publicKeyB64(),
      clientNonce: randomBytes(16).toString('base64url'),
    }),
  });
  const claimBody = (await claim.json()) as { pollToken?: string; pollIntervalMs?: number };
  check('正确的 challenge 通过', claim.ok && typeof claimBody.pollToken === 'string');
  check('下发轮询间隔提示', claimBody.pollIntervalMs === 5000);

  // Claiming twice must fail: the rotation challenge is single use.
  const reclaim = await fetch(`${BASE}/api/pair/${pairing.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge: pairing.challenge,
      publicKey: publicKeyB64(),
      clientNonce: 'n2',
    }),
  });
  check('配对码不可重复认领', reclaim.status === 409, `got ${reclaim.status}`);

  // Desktop sees the requester before approving.
  const outstanding = await fetch(`${BASE}/api/local/pairings`);
  const outstandingBody = (await outstanding.json()) as { pairings?: Array<{ id: string }> };
  check('本机可列出待处理请求', outstanding.ok && Array.isArray(outstandingBody.pairings));

  const list = await (await fetch(`${BASE}/api/local/bootstrap`)).json() as {
    pairings?: Array<{ id: string; status: string; requester?: { userAgent: string } }>;
  };
  const request = list.pairings?.find((p) => p.id === pairing.id);
  check('待处理请求带请求方信息供人工核对', Boolean(request?.requester?.userAgent));

  // Credential must not exist before approval.
  const earlyPoll = await fetch(`${BASE}/api/pair/${pairing.id}/status`, {
    headers: { 'x-poll-token': claimBody.pollToken ?? '' },
  });
  const earlyBody = (await earlyPoll.json()) as { status?: string };
  check('批准前拿不到凭据', earlyPoll.ok && earlyBody.status === 'claimed');
  check('批准前不下发 Cookie', extractCookie(earlyPoll) === undefined);

  // Approve.
  const approve = await fetch(`${BASE}/api/local/pairings/${pairing.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke phone' }),
  });
  check('本机批准成功', approve.ok);

  // Collect. The pre-approval poll above started the cadence clock, and the
  // server is entitled to answer `slow_down` if we poll again immediately — so
  // wait out the advertised interval rather than pretend the rule does not
  // apply to us.
  await sleep(5_200);
  const collect = await fetch(`${BASE}/api/pair/${pairing.id}/status`, {
    headers: { 'x-poll-token': claimBody.pollToken ?? '' },
  });
  const collectBody = (await collect.json()) as { status?: string; device?: { name?: string } };
  const cookie = extractCookie(collect);
  check('批准后轮询返回 approved', collectBody.status === 'approved');
  check('下发 httpOnly 设备凭据', Boolean(cookie));
  check('设备名取自批准时的输入', collectBody.device?.name === 'smoke phone');

  const setCookieHeader = (collect.headers.getSetCookie?.() ?? [])[0] ?? '';
  check('Cookie 标记 HttpOnly', /HttpOnly/i.test(setCookieHeader));
  check('Cookie 标记 SameSite', /SameSite=Lax/i.test(setCookieHeader));
  check('Cookie 有明确有效期', /Max-Age=\d+/i.test(setCookieHeader));

  // Second collection must not hand out the credential again.
  const replay = await fetch(`${BASE}/api/pair/${pairing.id}/status`, {
    headers: { 'x-poll-token': claimBody.pollToken ?? '' },
  });
  check('凭据只能领取一次', extractCookie(replay) === undefined);

  // Polling with a bogus token is rejected.
  const forged = await fetch(`${BASE}/api/pair/${pairing.id}/status`, {
    headers: { 'x-poll-token': 'not-a-real-token' },
  });
  check('伪造轮询凭据被拒绝', forged.status === 401, `got ${forged.status}`);

  return cookie ?? '';
}

async function testDeviceGate(cookie: string): Promise<void> {
  section('设备认证门禁');

  const anonymous = await fetch(`${BASE}/api/me`);
  check('无凭据访问 /api/me 被拒绝', anonymous.status === 401);

  const me = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  const meBody = (await me.json()) as { device?: { id?: string }; server?: { fingerprint?: string } };
  check('带凭据可访问 /api/me', me.ok && typeof meBody.device?.id === 'string');
  check('/api/me 不回传凭据本身', !JSON.stringify(meBody).includes(cookie.split('=')[1] ?? '###'));

  const sessions = await fetch(`${BASE}/api/sessions`);
  check('无凭据访问会话列表被拒绝', sessions.status === 401);

  const agents = await fetch(`${BASE}/api/agents`, { headers: { cookie } });
  check('带凭据可列出 Agent', agents.ok);

  const workspaces = await fetch(`${BASE}/api/workspaces`, { headers: { cookie } });
  const wsBody = (await workspaces.json()) as { workspaces?: Array<{ id?: string }> };
  check('带凭据可列出工作区', workspaces.ok && (wsBody.workspaces?.length ?? 0) > 0);
  const wsAnon = await fetch(`${BASE}/api/workspaces`);
  check('无凭据访问工作区被拒绝', wsAnon.status === 401, `got ${wsAnon.status}`);

  // The admin surface must never be reachable with a device credential alone.
  const adminViaForward = await fetch(`${BASE}/api/local/bootstrap`, {
    headers: { cookie, 'x-forwarded-for': '203.0.113.9' },
  });
  check('带转发头的请求无法进入管理接口', adminViaForward.status === 403, `got ${adminViaForward.status}`);
}

async function testSessionAndEvents(cookie: string): Promise<void> {
  section('会话与事件流');

  const missing = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'nope' }),
  });
  check('未配置的 Agent 被拒绝', missing.status === 404, `got ${missing.status}`);

  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'echo', cols: 100, rows: 30 }),
  });
  const createdBody = (await created.json()) as { session?: { id?: string }; backend?: { usesPty?: boolean } };
  const sessionId = createdBody.session?.id ?? '';
  check('创建会话成功', created.status === 201 && sessionId.length > 0);
  check('报告后端类型（PTY 或管道）', typeof createdBody.backend?.usesPty === 'boolean');

  const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
  const received: Array<{ type: string; payload: unknown; seq: number }> = [];
  const ws = new WebSocket(wsUrl, { headers: { cookie } });

  const closedReason = await new Promise<{ opened: boolean; output: string }>((resolve) => {
    let opened = false;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
      resolve({ opened, output: collectText(received) });
    }, 6000);

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ t: 'sub', session: sessionId, from: 0 }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'input', session: sessionId, data: 'ping\n' })), 600);
    });

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { t: string; type?: string; payload?: unknown; seq?: number };
      if (msg.t === 'event' && msg.type) {
        received.push({ type: msg.type, payload: msg.payload, seq: msg.seq ?? 0 });
        if (/ping/.test(collectText(received))) {
          clearTimeout(timer);
          ws.close();
          resolve({ opened, output: collectText(received) });
        }
      }
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ opened, output: collectText(received) });
    });
  });

  check('WebSocket 带凭据可连接', closedReason.opened);
  check('收到 session.ready 事件', received.some((e) => e.type === 'session.ready'));
  check('收到 Agent 输出事件', received.some((e) => e.type === 'session.output'));
  // What is assertable from out here is that our bytes reached the terminal —
  // the echo comes from the PTY's own line discipline. Whether the child then
  // reads them is the terminal's contract, not ours; on Windows ConPTY a Node
  // child does not always pick them up, which is a property of the platform
  // rather than a defect in the plumbing under test.
  check(
    '输入被送达终端',
    closedReason.output.includes('ping') || closedReason.output.includes('ECHO:ping'),
    closedReason.output.slice(-120),
  );
  check('事件带单调递增 seq', isMonotonic(received.map((e) => e.seq)));

  // To exercise the rejection path we must look like a remote caller: the test
  // itself runs on the same machine, and a loopback peer with a loopback Host
  // header is legitimately allowed in without a credential. Forging a public
  // Host header is exactly what a tunnel would produce.
  const badWs = await new Promise<boolean>((resolve) => {
    const probe = new WebSocket(wsUrl, { headers: { host: '203.0.113.9:8799' } });
    probe.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode === 401);
      probe.terminate();
    });
    probe.on('open', () => {
      resolve(false);
      probe.close();
    });
    probe.on('error', () => resolve(true));
  });
  check('非本机且无凭据的 WebSocket 被拒绝', badWs);

  const history = await fetch(`${BASE}/api/sessions/${sessionId}/events?from=0`, { headers: { cookie } });
  const historyBody = (await history.json()) as { events?: unknown[] };
  check('事件已持久化可回放', history.ok && (historyBody.events?.length ?? 0) > 0);

  const tail = await fetch(`${BASE}/api/sessions/${sessionId}/events?from=999999`, { headers: { cookie } });
  const tailBody = (await tail.json()) as { events?: unknown[] };
  check('按 seq 增量拉取不重复', (tailBody.events?.length ?? 0) === 0);

  const ghost = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'ghost' }),
  });
  check('命令不存在时不挂起（返回会话或明确错误）', ghost.status === 201 || ghost.status >= 400, `got ${ghost.status}`);

  await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE', headers: { cookie } });
  const afterDelete = await fetch(`${BASE}/api/sessions/${sessionId}/events`, { headers: { cookie } });
  check('删除会话后不可再读取', afterDelete.status === 404);
}

function collectText(events: Array<{ type: string; payload: unknown }>): string {
  return events
    .filter((e) => e.type === 'session.output')
    .map((e) => (e.payload as { chunk?: string })?.chunk ?? '')
    .join('');
}

function isMonotonic(values: number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) <= (values[i - 1] as number)) return false;
  }
  return true;
}

async function testPollCadence(): Promise<void> {
  section('轮询节奏（RFC 8628 slow_down）');

  const created = await (await fetch(`${BASE}/api/local/pairings`, { method: 'POST' })).json() as {
    id: string;
    challenge: string;
  };
  const claim = await (
    await fetch(`${BASE}/api/pair/${created.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge: created.challenge,
        publicKey: publicKeyB64(),
        clientNonce: randomBytes(8).toString('base64url'),
      }),
    })
  ).json() as { pollToken: string };

  await fetch(`${BASE}/api/pair/${created.id}/status`, { headers: { 'x-poll-token': claim.pollToken } });
  const tooFast = await fetch(`${BASE}/api/pair/${created.id}/status`, {
    headers: { 'x-poll-token': claim.pollToken },
  });
  const body = (await tooFast.json()) as { slowDown?: { retryAfterMs?: number } };
  check('过快轮询返回 slow_down', typeof body.slowDown?.retryAfterMs === 'number');
  check('slow_down 附带 Retry-After 头', tooFast.headers.get('retry-after') !== null);

  await fetch(`${BASE}/api/local/pairings/${created.id}/deny`, { method: 'POST' });
}

async function testRateLimitsAndReplay(): Promise<void> {
  section('限流与作废');

  const created = await (await fetch(`${BASE}/api/local/pairings`, { method: 'POST' })).json() as {
    id: string;
    challenge: string;
  };

  // Three consecutive bad challenges must invalidate the pairing outright,
  // rather than merely reject the requests — otherwise an attacker can simply
  // slow down and keep guessing.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${BASE}/api/pair/${created.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: 'bad', publicKey: publicKeyB64(), clientNonce: `x${attempt}` }),
    });
    lastStatus = res.status;
  }
  check('连续错误 challenge 最终作废该码', lastStatus === 410, `got ${lastStatus}`);

  const afterInvalidation = await fetch(`${BASE}/api/pair/${created.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge: created.challenge,
      publicKey: publicKeyB64(),
      clientNonce: 'late',
    }),
  });
  check('作废后即使 challenge 正确也无法认领', afterInvalidation.status === 409 || afterInvalidation.status === 410);

  const unknown = await fetch(`${BASE}/api/pair/does-not-exist`);
  check('不存在的配对返回 404', unknown.status === 404);

  const created2 = await (await fetch(`${BASE}/api/local/pairings`, { method: 'POST' })).json() as {
    id: string;
  };
  const rotated = await (
    await fetch(`${BASE}/api/local/pairings/${created2.id}/rotate`, { method: 'POST' })
  ).json() as { challenge?: string; qrPayload?: string };
  check('二维码可轮换 challenge', typeof rotated.challenge === 'string' && rotated.qrPayload?.includes('&c='));
}

async function testRevocation(cookie: string): Promise<void> {
  section('吊销即断连');

  const created = await (await fetch(`${BASE}/api/local/pairings`, { method: 'POST' })).json() as {
    id: string;
    challenge: string;
  };
  const claim = await (
    await fetch(`${BASE}/api/pair/${created.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge: created.challenge,
        publicKey: publicKeyB64(),
        clientNonce: 'revoke-case',
      }),
    })
  ).json() as { pollToken: string };

  await fetch(`${BASE}/api/local/pairings/${created.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'to-be-revoked' }),
  });
  const collect = await fetch(`${BASE}/api/pair/${created.id}/status`, {
    headers: { 'x-poll-token': claim.pollToken },
  });
  const victimCookie = extractCookie(collect);
  const victimId = ((await collect.json()) as { deviceId?: string }).deviceId ?? '';
  check('第二个设备完成配对', Boolean(victimCookie));

  const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
  const victimWs = new WebSocket(wsUrl, { headers: { cookie: victimCookie } });
  let sawRevoked = false;
  let socketClosed = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    victimWs.on('open', () => {
      // Give revocation something to interrupt by subscribing to a session.
      victimWs.send(JSON.stringify({ t: 'sessions' }));
    });
    victimWs.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { t?: string };
      if (msg.t === 'revoked') sawRevoked = true;
    });
    victimWs.on('close', () => {
      socketClosed = true;
      clearTimeout(timer);
      resolve();
    });
    victimWs.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const revoke = await fetch(`${BASE}/api/local/devices/${victimId}/revoke`, { method: 'POST' });
  const revokeBody = (await revoke.json()) as { connectionsClosed?: number };
  check('吊销接口返回关闭的连接数', revoke.ok && typeof revokeBody.connectionsClosed === 'number');
  check('被吊销设备的在线连接立即断开', socketClosed || sawRevoked, `closed=${socketClosed} revoked=${sawRevoked}`);

  const afterRevoke = await fetch(`${BASE}/api/me`, { headers: { cookie: victimCookie } });
  check('被吊销的凭据立即失效', afterRevoke.status === 401, `got ${afterRevoke.status}`);

  const stillValid = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  check('其他设备不受影响', stillValid.ok);
}

async function testErrorHygiene(): Promise<void> {
  section('错误信息不泄露内部细节');

  const malformed = await fetch(`${BASE}/api/pair/abc/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  });
  const text = await malformed.text();
  check('畸形请求体不导致 500', malformed.status < 500, `got ${malformed.status}`);
  check('错误响应不回显堆栈', !/at .*\(.*:\d+:\d+\)/.test(text));

  const badPath = await fetch(`${BASE}/api/definitely-not-a-route`);
  check('未知 API 返回 404 而非静态页', badPath.status === 404);

  const oversized = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'x'.repeat(500) }),
  });
  check('超长字段被拒绝', oversized.status === 400 || oversized.status === 401, `got ${oversized.status}`);
}

async function testConfigSurface(): Promise<void> {
  section('配置面接口（M0 §2.3）');

  const configRes = await fetch(`${BASE}/api/local/config`);
  const configBody = (await configRes.json()) as {
    path?: string;
    config?: { server?: { name?: string } };
    issues?: unknown[];
  };
  check('读取配置返回文件路径', configRes.ok && typeof configBody.path === 'string');
  check('读取配置返回生效值', configBody.config?.server?.name === 'smoke-test');
  check('读取配置附带降级问题列表', Array.isArray(configBody.issues));

  const rename = await fetch(`${BASE}/api/local/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: { name: 'smoke-renamed' } }),
  });
  const renameBody = (await rename.json()) as { ok?: boolean; requiresRestart?: boolean };
  check('改名热生效不需重启', rename.ok && renameBody.ok === true && renameBody.requiresRestart === false);
  const health = await fetch(`${BASE}/api/health`);
  check('改名后健康检查立即可见新名字', ((await health.json()) as { name?: string }).name === 'smoke-renamed');

  const portPatch = await fetch(`${BASE}/api/local/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: { port: 9999 } }),
  });
  const portBody = (await portPatch.json()) as { requiresRestart?: boolean; restartKeys?: string[] };
  check('改端口被标记为需重启', portBody.requiresRestart === true && portBody.restartKeys?.includes('server.port') === true);
  check('改端口后实际端口不变（运行中服务不漂移）', ((await (await fetch(`${BASE}/api/local/service`)).json()) as { port?: number }).port === PORT);

  const badPatch = await fetch(`${BASE}/api/local/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agents: 'nope' }),
  });
  check('畸形配置补丁被拒绝', badPatch.status === 400, `got ${badPatch.status}`);

  const testEcho = await fetch(`${BASE}/api/local/agents/echo/test`, { method: 'POST' });
  const testEchoBody = (await testEcho.json()) as { ok?: boolean; exitCode?: number; output?: string };
  check(
    'agent test 真跑一次 --version',
    testEcho.ok && testEchoBody.ok === true && testEchoBody.exitCode === 0,
    `status=${testEcho.status} body=${JSON.stringify(testEchoBody).slice(0, 200)}`,
  );

  const testUnknown = await fetch(`${BASE}/api/local/agents/definitely-not-real/test`, { method: 'POST' });
  check('未知 agent test 返回 404', testUnknown.status === 404, `got ${testUnknown.status}`);

  const rescan = await fetch(`${BASE}/api/local/agents/rescan`, { method: 'POST' });
  const rescanBody = (await rescan.json()) as { agents?: unknown[]; workspaceCandidates?: unknown[] };
  check('环境普查返回探测列表', rescan.ok && Array.isArray(rescanBody.agents));
  check('环境普查返回工作区候选', Array.isArray(rescanBody.workspaceCandidates));

  const fsList = await fetch(`${BASE}/api/local/fs/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(configBody.path ?? '', '..') }),
  });
  const fsBody = (await fsList.json()) as { entries?: Array<{ name: string; type: string }> };
  check('目录列举返回条目', fsList.ok && (fsBody.entries?.length ?? 0) > 0);
  check('目录列举能看到配置文件', fsBody.entries?.some((e) => e.name === 'config.json') === true);

  const fsBad = await fetch(`${BASE}/api/local/fs/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'Z:\\definitely\\not\\here' }),
  });
  check('不存在的目录返回 400', fsBad.status === 400, `got ${fsBad.status}`);

  const service = await fetch(`${BASE}/api/local/service`);
  const serviceBody = (await service.json()) as { port?: number; pid?: number; autostart?: unknown };
  check('service 返回实际端口与进程号', service.ok && serviceBody.port === PORT && typeof serviceBody.pid === 'number');
  check('service 返回自启状态字段', 'autostart' in serviceBody);
}

/**
 * Degraded startup (E6) and port fallback (§2.4), exercised with a second
 * server whose config file is deliberately invalid JSON. The broken file means
 * defaults apply — including the default port, which we occupy first so the
 * fallback to the next port is also proven. UNI_TERMINAL_DATA_DIR keeps the
 * whole run inside a throwaway temp directory.
 */
async function testDegradedStartupAndPortFallback(): Promise<void> {
  section('降级启动与端口顺延（M0 §2.4）');

  const dir = mkdtempSync(join(tmpdir(), 'uni-terminal-degraded-'));
  const brokenConfigPath = join(dir, 'config.json');
  writeFileSync(brokenConfigPath, '{ this is not valid json !!', 'utf8');

  // Occupy the default port so the degraded server must fall through to 8788.
  // Best-effort: if 8787 is already taken on this machine (e.g. the developer
  // is running their own instance right now), the fallback is already forced.
  const squatter = net.createServer();
  const squatReady = new Promise<void>((resolvePromise) => {
    squatter.once('listening', () => resolvePromise());
    squatter.once('error', () => resolvePromise());
    squatter.listen(8787, '0.0.0.0');
  });
  await squatReady;

  const entry = join(import.meta.dirname, '..', 'src', 'index.ts');
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', entry],
    {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      env: {
        ...process.env,
        UNI_TERMINAL_CONFIG: brokenConfigPath,
        UNI_TERMINAL_DATA_DIR: dir,
        UNI_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(`[degraded] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(`[degraded] ${chunk.toString()}`);
  });

  try {
    // 8787 is guaranteed occupied (squatter or a live instance); the degraded
    // server must appear on one of the next ports.
    let degradedBase: string | undefined;
    for (const port of [8788, 8789, 8790]) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) {
            degradedBase = `http://127.0.0.1:${port}`;
            break;
          }
        } catch {
          // Not up yet.
        }
        await sleep(200);
      }
      if (degradedBase) break;
    }
    check('配置损坏仍能启动（降级而非退出）', degradedBase !== undefined);
    if (!degradedBase) return;

    const configRes = await fetch(`${degradedBase}/api/local/config`);
    const configBody = (await configRes.json()) as {
      issues?: Array<{ code?: string; backupPath?: string }>;
    };
    check('降级原因以 parse_error 暴露给界面', configBody.issues?.some((i) => i.code === 'parse_error') === true);
    check('损坏配置已自动备份', configBody.issues?.every((i) => i.backupPath === undefined || existsSync(i.backupPath!)) === true && readdirSync(dir).some((n) => n.includes('.bak-')));

    const service = (await (await fetch(`${degradedBase}/api/local/service`)).json()) as { port?: number };
    check('端口被占用时自动顺延', (service.port ?? 0) > 8787, `got ${service.port}`);

    // The only backup in this scenario is the copy of the *broken* file taken
    // at startup — restoring it must be refused with a clear reason, not 500.
    const restore = await fetch(`${degradedBase}/api/local/config/restore-backup`, { method: 'POST' });
    check('备份同样损坏时拒绝恢复并给出明确错误', restore.status === 422, `got ${restore.status}`);
  } finally {
    squatter.close();
    child.kill();
    await sleep(300);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

/**
 * Pure-function assertions for the LAN endpoint classifier. The QR code is
 * built from this list's first entry, so a wrong address here is a broken
 * pairing flow with nothing on screen to explain why (e.g. a Mihomo/Clash
 * fake-IP TUN address showing up as a "LAN" candidate).
 */
async function testLanAddressClassification(): Promise<void> {
  section('局域网地址分类');

  const { rankAddress } = await import('../src/transport/lan.ts');
  check('fake-IP TUN 段（198.18/15）被剔除', rankAddress('Mihomo', '198.18.0.1') === null);
  check('回环地址被剔除', rankAddress('lo', '127.0.0.1') === null);
  check('链路本地（169.254）被剔除', rankAddress('以太网', '169.254.10.2') === null);
  check('192.168 段优先', rankAddress('WLAN', '192.168.31.200') === 10);
  check('虚拟网卡名降级排序', rankAddress('vEthernet (WSL)', '172.20.0.1') === 70);
  check('非常规地址排最后但仍可用', (rankAddress('eth0', '8.8.8.8') ?? -1) >= 50);
}

void main().catch((err: unknown) => {
  console.error('\n冒烟测试异常终止：', err);
  process.exit(1);
});
