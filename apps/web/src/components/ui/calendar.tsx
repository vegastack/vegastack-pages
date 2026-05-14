import { DayPicker } from "react-day-picker";
import type { DayPickerProps } from "react-day-picker";
import { cn } from "../../lib/cn";

export type CalendarProps = DayPickerProps;

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("vpg-calendar", className)}
      classNames={{
        root: "vpg-calendar-root",
        months: "vpg-calendar-months",
        month: "vpg-calendar-month",
        month_caption: "vpg-calendar-caption",
        caption_label: "vpg-calendar-caption-label",
        nav: "vpg-calendar-nav",
        button_previous: "vpg-calendar-nav-button",
        button_next: "vpg-calendar-nav-button",
        chevron: "vpg-calendar-chevron",
        month_grid: "vpg-calendar-grid",
        weekdays: "vpg-calendar-weekdays",
        weekday: "vpg-calendar-weekday",
        weeks: "vpg-calendar-weeks",
        week: "vpg-calendar-week",
        day: "vpg-calendar-day",
        day_button: "vpg-calendar-day-button",
        outside: "vpg-calendar-day-outside",
        selected: "vpg-calendar-day-selected",
        today: "vpg-calendar-day-today",
        disabled: "vpg-calendar-day-disabled",
        ...classNames,
      }}
      {...props}
    />
  );
}
