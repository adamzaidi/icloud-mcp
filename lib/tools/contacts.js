// iCloud Contacts (CardDAV) tools.
import { TIMEOUT, withTimeout } from '../imap.js';
import { listContacts, searchContacts, getContact, createContact, updateContact, deleteContact } from '../carddav.js';


export const contactTools = [
  // ── CardDAV / Contacts ──
  {
    name: 'list_contacts',
    description: 'List contacts from iCloud Contacts, sorted by name. Returns names, phones, emails, addresses and other basic fields, plus total and hasMore for paging. Photos are never returned (hasPhoto says whether one exists). To find a specific person use search_contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max contacts to return (default 50, max 500)' },
        offset: { type: 'number', description: 'Skip this many contacts (default 0, for pagination)' }
      }
    }
  },
  {
    name: 'search_contacts',
    description: 'Search iCloud Contacts by name, nickname, email address, phone number, company, or note text. A phone number matches whatever format it is stored in.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        limit: { type: 'number', description: 'Max contacts to return (default 25, max 200). total reports how many matched.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_contact',
    description: 'Get full details for a specific contact by ID, including fields the other tools do not edit (related names, social profiles, dates) under "other". Use list_contacts or search_contacts to find a contactId.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact ID (UUID from list_contacts or search_contacts)' }
      },
      required: ['contactId']
    }
  },
  {
    name: 'create_contact',
    description: 'Create a new contact in iCloud Contacts. Give at least a name or an organization.',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        middleName: { type: 'string', description: 'Middle name' },
        prefix: { type: 'string', description: 'Name prefix, e.g. Dr.' },
        suffix: { type: 'string', description: 'Name suffix, e.g. Jr.' },
        fullName: { type: 'string', description: 'Display name. If omitted it is built from the name parts.' },
        nickname: { type: 'string', description: 'Nickname.' },
        org: { type: 'string', description: 'Organization / company name.' },
        department: { type: 'string', description: 'Department within the organization.' },
        title: { type: 'string', description: 'Job title.' },
        phone: { type: 'string', description: 'Primary phone number (shorthand for a one-item phones list)' },
        email: { type: 'string', description: 'Primary email address (shorthand for a one-item emails list)' },
        phones: { type: 'array', description: 'The complete list of phones. Replaces the existing list; an entry whose number is already on the contact keeps its label. Each: { number, type?, preferred? }. type is mobile, home, work, main, iphone, fax, pager, other, or any custom label.', items: { type: 'object', properties: { number: { type: 'string' }, type: { type: 'string' }, preferred: { type: 'boolean' } }, required: ['number'] } },
        emails: { type: 'array', description: 'The complete list of emails. Replaces the existing list; an address already on the contact keeps its label. Each: { email, type?, preferred? }. type is home, work, other, or any custom label.', items: { type: 'object', properties: { email: { type: 'string' }, type: { type: 'string' }, preferred: { type: 'boolean' } }, required: ['email'] } },
        addresses: { type: 'array', description: 'The complete list of postal addresses. Replaces the existing list. Each: { street, city, state, zip, country, type? } with type home, work, other, or a custom label.', items: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, zip: { type: 'string' }, country: { type: 'string' }, type: { type: 'string' } } } },
        birthday: { type: 'string', description: 'Birthday as YYYY-MM-DD, or --MM-DD when the year is unknown.' },
        note: { type: 'string', description: 'Notes / free text.' },
        url: { type: 'string', description: 'Website URL' }
      }
    }
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact in iCloud Contacts in place. Only the fields passed are changed; every other part of the card (photo, labels, other names, related people, extra URLs) is left exactly as it is.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact ID to update' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        middleName: { type: 'string', description: 'Middle name' },
        prefix: { type: 'string', description: 'Name prefix, e.g. Dr.' },
        suffix: { type: 'string', description: 'Name suffix, e.g. Jr.' },
        fullName: { type: 'string', description: 'Display name. If omitted it is built from the name parts.' },
        nickname: { type: 'string', description: 'Nickname. Pass an empty string to clear it.' },
        org: { type: 'string', description: 'Organization / company name. Pass an empty string to clear it.' },
        department: { type: 'string', description: 'Department within the organization. Pass an empty string to clear it.' },
        title: { type: 'string', description: 'Job title. Pass an empty string to clear it.' },
        phone: { type: 'string', description: 'Make this the primary phone number. It is added if the contact does not have it; existing numbers are kept. To remove or relabel numbers use phones.' },
        email: { type: 'string', description: 'Make this the primary email address. It is added if the contact does not have it; existing addresses are kept. To remove or relabel addresses use emails.' },
        phones: { type: 'array', description: 'The complete list of phones. Replaces the existing list; an entry whose number is already on the contact keeps its label. Each: { number, type?, preferred? }. type is mobile, home, work, main, iphone, fax, pager, other, or any custom label.', items: { type: 'object', properties: { number: { type: 'string' }, type: { type: 'string' }, preferred: { type: 'boolean' } }, required: ['number'] } },
        emails: { type: 'array', description: 'The complete list of emails. Replaces the existing list; an address already on the contact keeps its label. Each: { email, type?, preferred? }. type is home, work, other, or any custom label.', items: { type: 'object', properties: { email: { type: 'string' }, type: { type: 'string' }, preferred: { type: 'boolean' } }, required: ['email'] } },
        addresses: { type: 'array', description: 'The complete list of postal addresses. Replaces the existing list. Each: { street, city, state, zip, country, type? } with type home, work, other, or a custom label.', items: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, zip: { type: 'string' }, country: { type: 'string' }, type: { type: 'string' } } } },
        birthday: { type: 'string', description: 'Birthday as YYYY-MM-DD, or --MM-DD when the year is unknown. Pass an empty string to clear it.' },
        note: { type: 'string', description: 'Notes / free text. Pass an empty string to clear it.' },
        url: { type: 'string', description: 'Website URL (sets the first URL; any others are kept). Pass an empty string to clear it.' }
      },
      required: ['contactId']
    }
  },
  {
    name: 'delete_contact',
    description: 'Delete a contact from iCloud Contacts permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact ID to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['contactId']
    }
  },
];

const _contactTools_NAMES = new Set(contactTools.map((tool) => tool.name));

export async function handleContactTool(name, args, ctx) {
  if (!_contactTools_NAMES.has(name)) return undefined;
  const { resolveCreds, resolveMailbox, accounts: ACCOUNTS } = ctx;
  let result;
  if (name === 'list_contacts') {
    result = await withTimeout('list_contacts', TIMEOUT.FETCH, () =>
      listContacts(args.limit || 50, args.offset || 0)
    );
  } else if (name === 'search_contacts') {
    result = await withTimeout('search_contacts', TIMEOUT.FETCH, () =>
      searchContacts(args.query, args.limit || 25)
    );
  } else if (name === 'get_contact') {
    result = await withTimeout('get_contact', TIMEOUT.FETCH, () =>
      getContact(args.contactId)
    );
  } else if (name === 'create_contact') {
    const { contactId: _ignore, ...fields } = args;
    result = await withTimeout('create_contact', TIMEOUT.FETCH, () =>
      createContact(fields)
    );
  } else if (name === 'update_contact') {
    const { contactId, ...fields } = args;
    result = await withTimeout('update_contact', TIMEOUT.FETCH, () =>
      updateContact(contactId, fields)
    );
  } else if (name === 'delete_contact') {
    result = await withTimeout('delete_contact', TIMEOUT.SINGLE, () =>
      deleteContact(args.contactId, args.dryRun || false)
    );
  // ── CalDAV / Calendar (FETCH tier 30s) ──
  }
  return result;
}

