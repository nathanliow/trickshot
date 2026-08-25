/** Hand a finished recording to the browser as a download. */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked late: some browsers read the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
