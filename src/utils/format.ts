/**
 * Post-process AI engine responses for clean Telegram display.
 * Strips Markdown formatting and adds emoji for readability.
 * Preserves inline code (`...`) and code blocks (```...```).
 */

/**
 * Clean Markdown artifacts from AI response text.
 */
export function cleanMarkdown(text: string): string {
  // Extract code blocks to protect them from processing
  const codeBlocks: string[] = [];
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK_${codeBlocks.length - 1}\x00`;
  });

  // Extract inline code to protect them
  const inlineCodes: string[] = [];
  processed = processed.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00INLINE_${inlineCodes.length - 1}\x00`;
  });

  // Headers → emoji prefixed lines
  processed = processed.replace(/^#{1,2}\s+(.+)$/gm, '📋 $1');
  processed = processed.replace(/^#{3,6}\s+(.+)$/gm, '📌 $1');

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '$1');
  processed = processed.replace(/__(.+?)__/g, '$1');

  // Italic: *text* or _text_ (single)
  processed = processed.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '$1');
  processed = processed.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '$1');

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, '$1');

  // Unordered list markers: - or * at line start → bullet
  processed = processed.replace(/^[\s]*[-*]\s+/gm, '  • ');

  // Horizontal rules: --- or *** or ___
  processed = processed.replace(/^[-*_]{3,}\s*$/gm, '───────────────');

  // Restore inline code
  processed = processed.replace(/\x00INLINE_(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return processed;
}
