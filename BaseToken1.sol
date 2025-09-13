// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }
}

abstract contract Ownable is Context {
    address private _owner;

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

interface IERC20 {
    function totalSupply() external view returns (uint256);

    function balanceOf(address who) external view returns (uint256);

    function allowance(
        address _owner,
        address spender
    ) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);

    function approve(address spender, uint256 value) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );
}

contract Chandra is IERC20, Ownable {
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) internal _allowances;
    mapping(address => bool) internal _wls;

    uint256 public totalSupply = 1000000000 * 10 ** 18;
    bool public launched;

    string public name = unicode"Justice for Chandra";
    string public symbol = unicode"Chandra";

    constructor() Ownable(msg.sender) {
        _balances[owner()] += totalSupply;
        _wls[owner()] = true;
        emit Transfer(address(0), owner(), totalSupply);
    }

    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    function balanceOf(
        address _owner
    ) external view override returns (uint256) {
        return _balances[_owner];
    }

    function allowance(
        address _owner,
        address spender
    ) external view override returns (uint256) {
        return _allowances[_owner][spender];
    }

    function transfer(
        address to,
        uint256 value
    ) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(
        address spender,
        uint256 value
    ) external override returns (bool) {
        require(spender != address(0), "cannot approve the 0 address");

        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external override returns (bool) {
        _allowances[from][msg.sender] = _allowances[from][msg.sender] - value;
        _transfer(from, to, value);
        emit Approval(from, msg.sender, _allowances[from][msg.sender]);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "cannot be zero address");
        require(from != to, "you cannot transfer to yourself");
        require(
            _transferAllowed(from, to),
            "This token is not launched and cannot be listed on dexes yet."
        );
        _balances[from] -= value;
        _balances[to] += value;
        emit Transfer(from, to, value);
    }

    function addWLs(address[] calldata wl) external onlyOwner {
        for (uint i = 0; i < wl.length; i++) {
            _wls[wl[i]] = true;
        }
    }

    function launch() external virtual onlyOwner {
        require(launched == false, "contract already launched");
        launched = true;
    }

    function _transferAllowed(
        address from,
        address to
    ) private view returns (bool) {
        if (launched) return true;
        if (from == owner() || to == owner()) return true;
        if (!launched && !_wls[to]) return false;
        return true;
    }
}