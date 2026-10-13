import { stripe } from '@/lib/stripe';

export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.STRIPE_WEBHOOK_SECRET!);
  return Response.json({ received: event.type });
}
