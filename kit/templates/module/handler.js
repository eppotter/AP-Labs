'use strict';

// TODO: one or two lines on what this module does and for whom.
// Guide: kit/templates/module.md. This is trusted, reviewed code, not sandboxed.
//
// ctx: person { id, name }, client { id, name }, module { id, label },
// data.run(sql, params) (read-only, guarded), reply(text) (private to the person).
// Import engine helpers only from '#sdk'.

module.exports = async function myModule({ person, client, reply }) {
  await reply(`Hi ${person.name}, this is a new ${client.name} tool. It does not do anything yet.`);
};
