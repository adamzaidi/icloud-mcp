// iCloud Contacts (CardDAV) tools.
import { TIMEOUT, withTimeout } from '../imap.js';
import { listContacts, searchContacts, getContact, createContact, updateContact, deleteContact } from '../carddav.js';


export const contactTools = [
  // ── CardDAV / Contacts ──
  {
    name: 'list_contacts',
    description: 'List contacts from iCloud Contacts. Returns names, phones, emails, and other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max contacts to return (default 50)' },
        offset: { type: 'number', description: 'Skip this many contacts (default 0, for pagination)' }
      }
    }
  },
  {
    name: 'search_contacts',
    description: 'Search iCloud Contacts by name, email address, or phone number.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (matched against name, email, and phone)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_contact',
    description: 'Get full details for a specific contact by ID. Use list_contacts or search_contacts to find a contactId.',
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
    description: 'Create a new contact in iCloud Contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        fullName: { type: 'string', description: 'Full display name (overrides firstName + lastName for FN field)' },
        org: { type: 'string', description: 'Organization / company name' },
        phone: { type: 'string', description: 'Primary phone number (shorthand for phones array)' },
        email: { type: 'string', description: 'Primary email address (shorthand for emails array)' },
        phones: { type: 'array', description: 'Array of phone objects: [{ number, type }] where type is cell/home/work/etc.' },
        emails: { type: 'array', description: 'Array of email objects: [{ email, type }] where type is home/work/etc.' },
        addresses: { type: 'array', description: 'Array of address objects: [{ street, city, state, zip, country, type }]' },
        birthday: { type: 'string', description: 'Birthday in YYYY-MM-DD format' },
        note: { type: 'string', description: 'Notes / free text' },
        url: { type: 'string', description: 'Website URL' }
      }
    }
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact in iCloud Contacts. Only provided fields are changed; others are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact ID to update' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        fullName: { type: 'string' },
        org: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        phones: { type: 'array' },
        emails: { type: 'array' },
        addresses: { type: 'array' },
        birthday: { type: 'string' },
        note: { type: 'string' },
        url: { type: 'string' }
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
      searchContacts(args.query)
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

