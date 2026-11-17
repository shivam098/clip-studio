import { spawn } from 'node:child_process';

export function run(command, args, { signal, cwd, env, maxOutput = 2_000_000, input } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: env ?? process.env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failure = null, killTimer;
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const abort = () => {
      failure = signal.reason ?? new Error('Cancelled');
      kill();
      killTimer = setInterval(kill, 1000);
    };
    const capture = (chunk, stream) => {
      if (stream === 'out') stdout += chunk;
      else stderr = (stderr + chunk).slice(-maxOutput);
      if (stdout.length > maxOutput) { failure = new Error('Subprocess output exceeded limit'); kill(); }
    };
    child.stdout.on('data', chunk => capture(chunk, 'out'));
    child.stderr.on('data', chunk => capture(chunk, 'err'));
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearInterval(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command.split(/[\\/]/).at(-1)} exited ${code}: ${stderr.slice(-1800).replace(/https?:\/\/\S+/g, '[remote URL]')}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { failure = error; kill(); } });
    child.stdin.end(input);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
