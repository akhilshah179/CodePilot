const { Kafka } = require('kafkajs');
const nodemailer = require('nodemailer');

const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKERS] });
const consumer = kafka.consumer({ groupId: 'notifier' });
const mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST });

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'order-created' });
  await consumer.run({
    eachMessage: async ({ message }) => {
      await mailer.sendMail({ to: 'ops@example.com', subject: 'New order', text: message.value.toString() });
    },
  });
}

main();
