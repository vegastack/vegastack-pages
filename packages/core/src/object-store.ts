export type StoredObject = {
  key: string;
  body: string;
  contentType?: string;
  updatedAt: string;
};

// Bodies the store can accept on `put`. Text remains the common case;
// binary (ArrayBuffer / Uint8Array) is for image and other binary
// attachments where round-tripping through UTF-8 would corrupt bytes.
// Reads continue to surface `body: string` for text callers — binary
// downloads bypass this facade entirely and use the platform R2
// binding directly (see /img/[...key] route).
export type ObjectStorePutBody = string | ArrayBuffer | Uint8Array;

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    body: ObjectStorePutBody,
    options?: { contentType?: string },
  ): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

export type R2LikeBucket = {
  get(key: string): Promise<{
    text(): Promise<string>;
    httpMetadata?: { contentType?: string };
    uploaded?: Date;
  } | null>;
  put(
    key: string,
    value: ObjectStorePutBody,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ uploaded?: Date } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{
    objects: Array<{
      key: string;
      uploaded?: Date;
      httpMetadata?: { contentType?: string };
    }>;
  }>;
};

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2LikeBucket) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      key,
      body: await object.text(),
      contentType: object.httpMetadata?.contentType,
      updatedAt: object.uploaded?.toISOString() ?? new Date().toISOString(),
    };
  }

  async put(
    key: string,
    body: ObjectStorePutBody,
    options: { contentType?: string } = {},
  ): Promise<StoredObject> {
    const written = await this.bucket.put(key, body, {
      httpMetadata: { contentType: options.contentType },
    });
    return {
      key,
      // Read-back returns the empty string for binary uploads through
      // this facade; callers that need raw bytes go through the R2
      // binding directly. Text uploads round-trip unchanged.
      body: typeof body === "string" ? body : "",
      contentType: options.contentType,
      updatedAt: written?.uploaded?.toISOString() ?? new Date().toISOString(),
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const listed = await this.bucket.list({ prefix });
    return Promise.all(
      listed.objects.map(async (object) => {
        const stored = await this.get(object.key);
        return (
          stored ?? {
            key: object.key,
            body: "",
            contentType: object.httpMetadata?.contentType,
            updatedAt:
              object.uploaded?.toISOString() ?? new Date().toISOString(),
          }
        );
      }),
    );
  }
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    body: ObjectStorePutBody,
    options: { contentType?: string } = {},
  ): Promise<StoredObject> {
    const object = {
      key,
      // Stash a string representation; binary bytes round-trip through
      // utf-8 lossily, which is acceptable for the in-memory tests
      // (they only round-trip text). Production uses R2ObjectStore.
      body: typeof body === "string" ? body : new TextDecoder().decode(body),
      contentType: options.contentType,
      updatedAt: new Date().toISOString(),
    };
    this.objects.set(key, object);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.values()].filter((object) =>
      object.key.startsWith(prefix),
    );
  }
}
