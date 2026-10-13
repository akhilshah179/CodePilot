import { Checkout } from '@/components/Checkout';
import { listOrders } from '@/services/orders';

export default async function Home() {
  const orders = await listOrders();
  return (
    <main>
      <Checkout />
      <p>{orders.length} orders</p>
    </main>
  );
}
