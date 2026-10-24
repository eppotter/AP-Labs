'use strict';

module.exports = async function echo({ person, client, module, reply }) {
  await reply(`echo for ${person.name} (${person.id}) at ${client.name} from ${module.id}`);
};
