import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createOrder, listOrders } from '@/services/orders';

export async function GET() {
  return Response.json(await listOrders());
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const body = await req.json();
  return Response.json(await createOrder(body.total));
}
