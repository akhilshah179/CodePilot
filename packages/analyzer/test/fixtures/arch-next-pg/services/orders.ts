import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';

export async function listOrders() {
  return prisma.order.findMany();
}

export async function createOrder(total: number) {
  const intent = await stripe.paymentIntents.create({ amount: total, currency: 'usd' });
  return prisma.order.create({ data: { total, intentId: intent.id } });
}
