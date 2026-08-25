export interface PendingObjectWrite {
  writeId: string;
  size: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface PendingObjectRecovery {
  writeId: string;
  bucket: string;
  name: string;
}

export interface ObjectRecoveryReport {
  rolledBack: number;
  finalized: number;
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface StoredObject {
  body: ReadableStream<Uint8Array> | null;
  size?: number;
  contentType?: string;
}

export interface ListedObject {
  bucket: string;
  name: string;
  size: number;
  backendKey?: string;
  kind?: "data" | "temporary" | "control";
}

export interface ObjectStore {
  readonly driver: "local" | "s3";
  acquireOwnership?(projectId: string): Promise<void>;
  releaseOwnership?(): Promise<void>;
  health(): Promise<boolean>;
  write(
    bucket: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PendingObjectWrite>;
  read(bucket: string, name: string): Promise<StoredObject>;
  remove(bucket: string, name: string): Promise<void>;
  list?(): Promise<ListedObject[]>;
  readListed?(object: ListedObject): Promise<StoredObject>;
  removeListed?(object: ListedObject): Promise<void>;
  restoreListed?(
    object: ListedObject,
    body: ReadableStream<Uint8Array> | null,
    contentType?: string,
  ): Promise<void>;
  recoverPendingWrites?(
    isMetadataCommitted: (write: PendingObjectRecovery) => Promise<boolean>,
  ): Promise<ObjectRecoveryReport>;
}
