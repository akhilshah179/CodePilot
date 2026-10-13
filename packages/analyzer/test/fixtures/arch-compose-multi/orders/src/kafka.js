const { Kafka } = require('kafkajs');

const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKERS] });
const producer = kafka.producer();

module.exports = { producer };
