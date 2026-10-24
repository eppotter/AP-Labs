'use strict';

// The hello-world module: proves a hub entry reaches its handler and the reply
// stays private. It names the person and the client, nothing else.

module.exports = async function helloWorld({ person, client, reply }) {
  await reply(`Hello ${person.name}! I'm the ${client.name} bot, and this reply is only visible to you.`);
};
