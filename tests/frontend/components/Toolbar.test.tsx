import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toolbar } from '../../../frontend/src/components/Toolbar';
import { COLORS } from '../../../frontend/src/constants';

describe('Toolbar', () => {
  const baseProps = {
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canUndo: true,
    canRedo: true,
  };

  it('renders all 5 color buttons', () => {
    render(<Toolbar activeColor={COLORS[0]} onColorChange={() => {}} connectionStatus="disconnected" {...baseProps} />);
    for (const color of COLORS) {
      expect(screen.getByTestId(`color-${color}`)).toBeInTheDocument();
    }
  });

  it('calls onColorChange when a color button is clicked', async () => {
    const user = userEvent.setup();
    const onColorChange = vi.fn();
    render(<Toolbar activeColor={COLORS[0]} onColorChange={onColorChange} connectionStatus="disconnected" {...baseProps} />);

    await user.click(screen.getByTestId(`color-${COLORS[2]}`));
    expect(onColorChange).toHaveBeenCalledWith(COLORS[2]);
  });

  it('shows active color with a border', () => {
    render(<Toolbar activeColor={COLORS[1]} onColorChange={() => {}} connectionStatus="disconnected" {...baseProps} />);
    const activeBtn = screen.getByTestId(`color-${COLORS[1]}`);
    expect(activeBtn.style.borderWidth).toBe('3px');
    expect(activeBtn.style.borderStyle).toBe('solid');
  });

  it('shows "Connected" when status is connected', () => {
    render(<Toolbar activeColor={COLORS[0]} onColorChange={() => {}} connectionStatus="connected" {...baseProps} />);
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Connected');
  });

  it('shows "Connecting..." when status is connecting', () => {
    render(<Toolbar activeColor={COLORS[0]} onColorChange={() => {}} connectionStatus="connecting" {...baseProps} />);
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Connecting...');
  });

  it('shows "Disconnected" when status is disconnected', () => {
    render(<Toolbar activeColor={COLORS[0]} onColorChange={() => {}} connectionStatus="disconnected" {...baseProps} />);
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Disconnected');
  });

  it('triggers undo and redo callbacks', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <Toolbar
        activeColor={COLORS[0]}
        onColorChange={() => {}}
        connectionStatus="connected"
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo
        canRedo
      />,
    );

    await user.click(screen.getByTestId('undo-button'));
    await user.click(screen.getByTestId('redo-button'));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });
});
