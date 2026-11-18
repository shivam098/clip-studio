import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, readdir, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const maxVideo = 2 * 1024 ** 3, chunkSize = 8 * 1024 ** 2;
const ttl = 60 * 60_000;
export class Uploads {
  constructor(root, admit) {
    this.folder = join(root, 'partial-uploads'); this.assets = join(root, 'uploads');
    this.admit = admit; this.entries = new Map();
  }
  async init() {
    await mkdir(this.folder, { recursive: true });
    // Only generated partial files from the previous process; completed sources are elsewhere.
    for (const item of await readdir(this.folder, { withFileTypes: true })) {
      if (item.isFile() && /^[a-f0-9-]{36}\.part$/.test(item.name)) await rm(join(this.folder, item.name));
    }
  }
  async begin(owner, input) {
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxVideo) throw new Error('Video must be between 1 byte and 2 GiB.');
    await this.prune();
    if (this.entries.size >= 4) throw new Error('Four uploads are already open; finish or cancel one.');
    const id = randomUUID(), file = join(this.folder, `${id}.part`);
    const entry = { ...input, owner, file, offset: 0, touched: Date.now(), busy: true };
    this.entries.set(id, entry);
    try { await (await open(file, 'wx', 0o600)).close(); }
    catch (error) { this.entries.delete(id); throw error; }
    finally { entry.busy = false; }
    return { id, chunkSize, offset: 0 };
  }
  get(id, owner) {
    const e = this.entries.get(id);
    if (!e || e.owner !== owner || (!e.busy && Date.now() - e.touched > ttl)) throw new Error('Upload expired or not owned by this session.');
    return e;
  }
  async append(id, owner, req, offset) {
    const e = this.get(id, owner), n = Number(req.headers['content-length']);
    if (e.busy || offset !== e.offset || !Number.isSafeInteger(n) || n < 1 || n > chunkSize || offset + n > e.size) {
      throw new Error('Unexpected piece size or offset; no bytes appended.');
    }
    e.busy = true;
    let bytes = 0;
    try {
      await pipeline(req, new Transform({ transform(chunk, enc, cb) {
        bytes += chunk.length; cb(bytes > n ? new Error('Piece too large.') : null, chunk);
      } }), createWriteStream(e.file, { flags: 'r+', start: offset }));
      if (bytes !== n) throw new Error('Incomplete upload piece.');
      e.offset += n; return { offset: e.offset };
    } finally { e.busy = false; e.touched = Date.now(); }
  }
  async finish(id, owner) {
    const e = this.get(id, owner);
    if (e.busy || e.offset !== e.size) throw new Error('Upload is incomplete.');
    e.busy = true;
    const directory = join(this.assets, id), file = join(directory, 'source.mp4');
    try {
      if ((await stat(e.file)).size !== e.size) throw new Error('Uploaded size does not match the declared size.');
      await mkdir(directory, { recursive: true }); await rename(e.file, file);
      return await this.admit(file, e.workspace, e.name, AbortSignal.timeout(30000), e.recovery);
    } catch (error) { await rm(directory, { force: true, recursive: true }); throw error; }
    finally { this.entries.delete(id); await rm(e.file, { force: true }); }
  }
  async cancel(id, owner) {
    const e = this.get(id, owner);
    if (e.busy) throw new Error('Piece still being processed.');
    this.entries.delete(id); await rm(e.file, { force: true });
  }
  async prune(all = false) {
    for (const [id,e] of this.entries) if (!e.busy && (all || Date.now() - e.touched > ttl)) {
      this.entries.delete(id); await rm(e.file, { force: true });
    }
  }
}
