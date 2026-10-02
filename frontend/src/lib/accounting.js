export function accountingTotal(people) {
  return people.reduce((sum, person) => sum + Number(person.total_price || 0), 0);
}

export function accountingGroups(people) {
  const groups = new Map();
  for (const person of people) {
    const group = groups.get(person.group_id) || { name: person.group_id, people: 0, total: 0 };
    group.people += 1;
    group.total += Number(person.total_price || 0);
    groups.set(person.group_id, group);
  }
  return [...groups.values()];
}
