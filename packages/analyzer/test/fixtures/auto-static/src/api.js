export async function searchBooks(query) {
  const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}
