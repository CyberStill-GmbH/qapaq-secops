const RAW_REFERENCE = /^raw:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Object key shared by every DurableRawStore adapter so S3 and Blob layouts stay identical. */
export function rawObjectKey(ref: string): string {
  if (!RAW_REFERENCE.test(ref)) throw new Error('Invalid raw reference');
  return `raw/v1/${ref.slice(4)}`;
}
