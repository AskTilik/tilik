/** Yields the `data:` payload of each Server-Sent Event line from a fetch body. */
export async function* readSSEData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
  } finally {
    // Stops the upstream download if the consumer bails out early.
    await reader.cancel().catch(() => {});
  }
}
