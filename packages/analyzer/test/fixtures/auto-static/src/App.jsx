import { useState } from 'react';
import { searchBooks } from './api.js';

export default function App() {
  const [results, setResults] = useState([]);
  async function handleSearch() {
    const data = await searchBooks('dune');
    setResults(data.docs);
  }
  return (
    <main>
      <button onClick={handleSearch}>Search books</button>
      <ul>{results.map((b) => <li key={b.key}>{b.title}</li>)}</ul>
    </main>
  );
}
