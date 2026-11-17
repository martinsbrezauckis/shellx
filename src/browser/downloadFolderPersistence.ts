/** Serialize backend writes so an older edit cannot finish after a newer one. */
export function createDownloadFolderWriter(
  update: (folder: string) => Promise<void>,
  publish: (folder: string) => unknown,
): (folder: string, isCurrent: () => boolean) => Promise<boolean> {
  let previous: Promise<unknown> = Promise.resolve();
  return (folder, isCurrent) => {
    const result = previous.then(async () => {
      if (!isCurrent()) return false;
      await update(folder);
      if (!isCurrent()) return false;
      publish(folder);
      return true;
    });
    previous = result.catch(() => undefined);
    return result;
  };
}
