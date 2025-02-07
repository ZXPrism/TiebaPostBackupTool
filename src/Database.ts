import { Post } from "./Post";

export class Database {
    private _DB: IDBDatabase | null = null;
    private readonly _DBName = "TiebaPostBackupToolDB";
    private readonly _TableName = "PostDB";

    constructor() {

    }

    public OpenDatabase(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this._DBName);

                request.onsuccess = (event) => {
                    this._DB = request.result;
                    resolve(this._DB);
                };

                request.onerror = (event) => {
                    reject(`无法打开数据库：${(event.target as IDBRequest).error}`);
                };

                request.onupgradeneeded = (event) => {
                    const db = (event.target as IDBRequest).result;
                    if (!db.objectStoreNames.contains(this._TableName)) {
                        db.createObjectStore(this._TableName, { keyPath: "postInfo.postID" });
                    }
                };
            } catch (error) {
                reject(error);
            }
        });
    };

    public AddPost = (post: Post): Promise<void> => {
        return new Promise(async (resolve, reject) => {
            try {
                const db = this._DB ?? await this.OpenDatabase();
                const transaction = db.transaction([this._TableName], "readwrite");
                const store = transaction.objectStore(this._TableName);

                const request = store.put(post);

                request.onsuccess = () => {
                    resolve();
                };

                request.onerror = (event) => {
                    reject(`无法增加新条目：${event.target}！`);
                };
            } catch (error) {
                reject(error);
            }
        });
    };

    public GetPost(postID: string): Promise<Post> {
        return new Promise(async (resolve, reject) => {
            try {
                const db = this._DB ?? await this.OpenDatabase();
                const transaction = db.transaction([this._TableName], "readonly");
                const store = transaction.objectStore(this._TableName);
                const request = store.get(postID);

                request.onsuccess = () => {
                    resolve(request.result);
                };

                request.onerror = (event) => {
                    reject(`无法获取条目：${(event.target as IDBRequest).error}`);
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    public DeletePost(postID: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                const db = this._DB ?? await this.OpenDatabase();
                const transaction = db.transaction([this._TableName], "readwrite");
                const store = transaction.objectStore(this._TableName);
                const request = store.delete(postID);

                request.onsuccess = () => {
                    resolve();
                };

                request.onerror = (event) => {
                    reject(`无法删除条目：${(event.target as IDBRequest).error}`);
                };
            } catch (error) {
                reject(error);
            }
        });
    }
};
