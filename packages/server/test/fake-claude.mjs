/**
 * 冒烟测试夹具：模拟 claude 的 stream-json 协议。
 * init → 回显输入（agent.text ECHO:*）→ 工具调用/结果 → 权限请求；
 * 收到 control_response 后以 PERMISSION:<behavior> 回显应答闭环。
 */
let buf = '';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'control_response') {
      process.stdout.write(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'PERMISSION:' + (msg.response?.behavior ?? '?') }] },
        }) + '\n',
      );
      continue;
    }
    const text = msg.message?.content?.[0]?.text ?? '';
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ECHO:' + text }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file1' }] } }) + '\n');
    process.stdout.write(
      JSON.stringify({ type: 'control_request', request_id: 'req1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\n',
    );
  }
});
