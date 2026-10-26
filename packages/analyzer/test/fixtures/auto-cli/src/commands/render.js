export function render(pages) {
  return `<ul>${pages.map((p) => `<li>${p}</li>`).join('')}</ul>`;
}
