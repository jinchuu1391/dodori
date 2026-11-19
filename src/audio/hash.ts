/**
 * 파일 내용 해시. 같은 곡을 두 번 열었을 때 중복 저장을 막고,
 * M3에서 PC와 모바일이 "같은 곡"이라고 합의하는 기준이 된다.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
