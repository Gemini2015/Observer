/** 复制到剪贴板；返回是否成功，调用方负责给出反馈。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
