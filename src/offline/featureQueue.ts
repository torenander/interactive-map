// IndexedDB-backed offline write queue for point and line features — the map_features
// counterpart of src/offline/queue.ts, and the same contract (docs/DATA-MODEL.md §
// Client-side write queue): entries carry the client-generated uuid used as the row id,
// so flushing through `save-feature` is an idempotent upsert, and last-write-wins on
// `updated_at` is the whole conflict story.
//
// Its own IndexedDB database rather than a second object store in the areas queue's.
// The two carry different payloads and flush to different write paths, and separate
// databases mean a schema change to one can never block or corrupt the other — adding a
// store to the existing database would have meant a version bump that every already
// installed client has to run through before either queue works again. The cost is one
// extra `indexedDB.open`, which happens only when something is actually queued.
//
// Deliberately no module-level connection cache, for the same reason queue.ts has none:
// "survives a reload" must be a property of durable storage, not of a variable that
// happens to outlive a test.
import type { FeatureGeometry, FeatureKind } from "../db/features";

const DB_NAME = "areamap-feature-queue";
const DB_VERSION = 1;
const STORE = "writes";

export type QueuedFeatureWrite = {
  id: string;
  geom: FeatureGeometry;
  kind: FeatureKind;
  rating: number;
  comment: string | null;
  queuedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open feature queue db"));
  });
}

export async function enqueueFeatureWrite(entry: QueuedFeatureWrite): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("could not enqueue feature write"));
    });
  } finally {
    db.close();
  }
}

export async function listQueuedFeatureWrites(): Promise<QueuedFeatureWrite[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedFeatureWrite[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as QueuedFeatureWrite[]);
      request.onerror = () => reject(request.error ?? new Error("could not list feature queue"));
    });
  } finally {
    db.close();
  }
}

export async function removeQueuedFeatureWrite(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("could not remove queued feature write"));
    });
  } finally {
    db.close();
  }
}

// Drains the whole queue — used by tests to isolate cases against fake-indexeddb's
// process-lifetime store.
export async function clearQueuedFeatureWrites(): Promise<void> {
  const entries = await listQueuedFeatureWrites();
  await Promise.all(entries.map((entry) => removeQueuedFeatureWrite(entry.id)));
}

// The save function is injected rather than imported, mirroring src/offline/flush.ts, so
// flush behaviour is testable without a network or a running Supabase instance.
export async function flushQueuedFeatureWrites(
  save: (entry: QueuedFeatureWrite) => Promise<unknown>,
): Promise<{ flushed: string[]; failed: string[] }> {
  const entries = await listQueuedFeatureWrites();
  const flushed: string[] = [];
  const failed: string[] = [];

  for (const entry of entries) {
    try {
      await save(entry);
      await removeQueuedFeatureWrite(entry.id);
      flushed.push(entry.id);
    } catch {
      // Left in the queue: a failed flush must not drop the write.
      failed.push(entry.id);
    }
  }

  return { flushed, failed };
}
