// Fictional records only; never copy owner-network output into this fixture.
export const searchPeople = [
  ['Studio Founder', 'Founder', '#define PIXEL GAMES'],
  ['Game CEO', 'Founder & CEO', 'Arcade Forge Gaming'],
  ['Gaming Investor', 'Investor, gaming and esports', 'Example Seed'],
  ['General Investor', 'Investor', 'Example Capital'],
  ['Investment Partner', 'General Partner', 'Example Ventures'],
  ['Game Engineer', 'Software Engineer', 'Example Games'],
  ['Climate Recruiter', 'Talent Acquisition Lead', 'Example Climate'],
  ['Climate Founder', 'Founder & CEO', 'Example Climate'],
  ['Investment Relations', 'Investor Relations Manager', 'Example Capital'],
  ['Fund Founder', 'Founder & CEO', 'Example Ventures'],
  ['Investment Principal', 'Principal', 'Example Ventures'],
].map(([name, position, company], i) => ({
  id: (i + 1).toString(16).padStart(64, '0'), sourceId: 'f'.repeat(64),
  rowId: `Connections.csv#record=${i + 2}`, category: 'connections',
  subject: `https://www.linkedin.com/in/fictional-${i}`,
  fields: { 'first name': name, position, company },
}))
