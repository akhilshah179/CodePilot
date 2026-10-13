// CommonJS inside a JSX component
const helpers = require('../lib/legacy-helpers');

export default function Legacy() {
  return <div>{helpers.x}</div>;
}
