export function formatDate(dateString) {
    // Handles "DD.MM.YYYY" and "DD.MM.YYYY HH:MM:SS"
    if (!dateString) return null;
    const [datePart, timePart] = dateString.split(' ');
    const [day, month, year] = datePart.split('.').map(Number);
    if (timePart) {
        const [hours, minutes, seconds] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hours || 0, minutes || 0, seconds || 0);
    }
    return new Date(year, month - 1, day);
}

export function getUpcomingEvents(events) {
    const today = new Date();
    return events.filter((event) => {
        // Check event date is in the future
        const eventDate = formatDate(event.date);
        // Check deadline is in the future (if present)
        let deadlineOk = true;
        if (event.deadline) {
            const deadlineDate = formatDate(event.deadline);
            deadlineOk = deadlineDate >= today;
        }
        return eventDate > today && deadlineOk;
    });
}