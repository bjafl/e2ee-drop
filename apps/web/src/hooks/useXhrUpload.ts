// fetch() has no cross-browser way to report request-body (upload) progress; XMLHttpRequest's
// upload.onprogress is the one reliable native mechanism for it (design spec §2, approach 1 —
// hybrid XHR-for-upload / fetch-for-download). Kept as a plain function, not a hook, since it has
// no component-lifecycle state of its own — callers (Task 10's UploadPage) own the progress state.
export function uploadWithProgress(url: string, body: Blob, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(body);
  });
}
