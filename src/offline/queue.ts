// IndexedDB-backed offline write queue. docs/DATA-MODEL.md § Client-side write queue:
// IndexedDB not localStorage (geometry payloads exceed the localStorage budget quickly),
// entries carry the client-generated uuid used as the row id so a flush through
// save-area is an idempotent upsert.
//
// Deliberately no module-level connection cache: every function opens its own
// connection and closes it when done. That means "survives a reload" is a real property
// of durable storage, not an artefact of an in-process variable that happens to outlive
// a test — see tests/unit/queue.test.ts.
const DB_NAME = "areamap-offline-queue";
const DB_VERSION = 1;
const STORE = "writes";

export type QueuedWrite = {
  id: string;
  geom: { type: "Polygon"; coordinates: number[][][] };
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
    request.onerror = () => reject(request.error ?? new Error("could not open queue db"));
  });
}

export async function enqueueWrite(entry: QueuedWrite): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("could not enqueue write"));
    });
  } finally {
    db.close();
  }
}

export async function listQueuedWrites(): Promise<QueuedWrite[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedWrite[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as QueuedWrite[]);
      request.onerror = () => reject(request.error ?? new Error("could not list queue"));
    });
  } finally {
    db.close();
  }
}

// Drains the whole queue. Used after a full successful flush cycle and by tests to
// isolate cases against fake-indexeddb's process-lifetime store.
export async function clearQueuedWrites(): Promise<void> {
  const entries = await listQueuedWrites();
  await Promise.all(entries.map((entry) => removeQueuedWrite(entry.id)));
}

export async function removeQueuedWrite(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("could not remove queued write"));
    });
  } finally {
    db.close();
  }
}
